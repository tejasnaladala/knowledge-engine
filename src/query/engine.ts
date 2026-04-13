import type { KnowledgeDB } from '../storage/db.js';
import type { StoredEntity, StoredReel } from '../types.js';
import { generateSimpleEmbedding } from '../storage/embeddings.js';
import { searchByVector } from '../storage/vector-search.js';
import { fuseScores, type RankedReel, type ScoredItem, type FusionWeights, DEFAULT_WEIGHTS } from './ranker.js';

// ── Query result types ───────────────────────────────────────────────────

export interface QueryResult {
  reels: RankedReel[];
  entities: StoredEntity[];
  facts: Array<{ claim: string; confidence: number; reelId: string }>;
  totalResults: number;
  query: string;
  timingMs: number;
}

export interface QueryOptions {
  limit?: number;
  weights?: FusionWeights;
  includeEntities?: boolean;
  includeFacts?: boolean;
}

// ── Multi-signal query engine ────────────────────────────────────────────

/**
 * Query the knowledge base using multiple signals:
 * 1. FTS5 keyword search
 * 2. Vector similarity search (trigram embeddings)
 * 3. Entity graph matching
 *
 * Results are fused using weighted score combination with recency decay.
 */
export function queryKnowledge(
  db: KnowledgeDB,
  query: string,
  opts: QueryOptions = {},
): QueryResult {
  const start = Date.now();
  const limit = opts.limit ?? 20;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const includeEntities = opts.includeEntities ?? true;
  const includeFacts = opts.includeFacts ?? true;

  // ── Signal 1: FTS5 keyword search ──────────────────────────────────
  const ftsResults: ScoredItem[] = [];
  try {
    const ftsReels = db.searchReelsFTS(query, limit * 2);
    // FTS5 rank is negative (more negative = better match), normalize to positive
    for (let i = 0; i < ftsReels.length; i++) {
      ftsResults.push({
        reelId: ftsReels[i].id,
        // Score by position: first result gets highest score
        score: 1.0 - (i / Math.max(ftsReels.length, 1)),
      });
    }
  } catch {
    // FTS query syntax error -- skip this signal
  }

  // ── Signal 2: Vector similarity search ─────────────────────────────
  const vectorResults: ScoredItem[] = [];
  try {
    const queryEmbedding = generateSimpleEmbedding(query);
    const vectorHits = searchByVector(db, queryEmbedding, limit * 2);
    for (const hit of vectorHits) {
      if (hit.similarity > 0) {
        vectorResults.push({
          reelId: hit.reelId,
          score: hit.similarity,
        });
      }
    }
  } catch {
    // Embeddings table might not have data yet -- skip
  }

  // ── Signal 3: Entity graph matching ────────────────────────────────
  const graphResults: ScoredItem[] = [];
  const matchedEntities: StoredEntity[] = [];

  try {
    // Find entities whose names match the query
    const entities = db.searchEntities(query, 10);
    matchedEntities.push(...entities);

    // Score reels by how many matching entities they contain
    const reelEntityScores = new Map<string, number>();

    for (const entity of entities) {
      const reelLinks = db.raw.prepare(`
        SELECT reel_id, confidence FROM reel_entities WHERE entity_id = ?
      `).all(entity.id) as Array<{ reel_id: string; confidence: number }>;

      for (const link of reelLinks) {
        const current = reelEntityScores.get(link.reel_id) ?? 0;
        reelEntityScores.set(link.reel_id, current + link.confidence);
      }
    }

    for (const [reelId, score] of reelEntityScores) {
      graphResults.push({ reelId, score });
    }
  } catch {
    // Entity search might fail -- skip
  }

  // ── Collect reel dates for recency scoring ─────────────────────────
  const allReelIds = new Set<string>();
  for (const r of ftsResults) allReelIds.add(r.reelId);
  for (const r of vectorResults) allReelIds.add(r.reelId);
  for (const r of graphResults) allReelIds.add(r.reelId);

  const reelDates = new Map<string, string>();
  for (const reelId of allReelIds) {
    const reel = db.getReelById(reelId);
    if (reel) {
      reelDates.set(reelId, reel.created_at);
    }
  }

  // ── Fuse scores ────────────────────────────────────────────────────
  const rankedReels = fuseScores(
    vectorResults,
    ftsResults,
    graphResults,
    reelDates,
    weights,
  ).slice(0, limit);

  // ── Collect facts from matched reels ───────────────────────────────
  const facts: Array<{ claim: string; confidence: number; reelId: string }> = [];
  if (includeFacts) {
    const topReelIds = rankedReels.slice(0, 5).map(r => r.reelId);
    for (const reelId of topReelIds) {
      const reelFacts = db.getFactsForReel(reelId);
      for (const fact of reelFacts) {
        facts.push({
          claim: fact.claim,
          confidence: fact.confidence,
          reelId,
        });
      }
    }
  }

  // ── Collect entities from matched reels (if not already found) ─────
  if (includeEntities && matchedEntities.length === 0) {
    const topReelIds = rankedReels.slice(0, 5).map(r => r.reelId);
    for (const reelId of topReelIds) {
      const reelEntities = db.getEntitiesForReel(reelId);
      for (const entity of reelEntities) {
        if (!matchedEntities.find(e => e.id === entity.id)) {
          matchedEntities.push(entity);
        }
      }
    }
  }

  const timingMs = Date.now() - start;

  return {
    reels: rankedReels,
    entities: matchedEntities,
    facts,
    totalResults: rankedReels.length,
    query,
    timingMs,
  };
}
