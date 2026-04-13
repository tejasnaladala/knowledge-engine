import type { KnowledgeDB } from '../storage/db.js';
import type { ExtractedKnowledge, StoredEntity } from '../types.js';

// ── Graph node/edge types for return values ──────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  description: string;
  evidenceCount: number;
}

export interface EntityMention {
  reelId: string;
  shortcode: string;
  context: string;
  confidence: number;
  createdAt: string;
}

// ── Graph construction ───────────────────────────────────────────────────

/**
 * Build graph nodes and edges from an extraction result.
 * Creates entities, relationships, and facts in the database,
 * complementing storeExtractionResult in store.ts.
 *
 * Returns the entity name -> ID mapping used for relationship creation.
 */
export function buildGraphFromExtraction(
  db: KnowledgeDB,
  reelId: string,
  knowledge: ExtractedKnowledge,
): Map<string, string> {
  const entityIdMap = new Map<string, string>();

  // Upsert all entities
  for (const entity of knowledge.entities) {
    const entityId = db.upsertEntity({
      name: entity.name,
      type: entity.type,
      description: entity.description,
      aliases: entity.aliases,
    });
    entityIdMap.set(entity.name, entityId);

    // Link entity to the reel
    db.linkReelEntity(reelId, entityId, entity.description, 1.0, 'analysis');
  }

  // Create relationships between entities
  for (const rel of knowledge.relationships) {
    const sourceId = entityIdMap.get(rel.source);
    const targetId = entityIdMap.get(rel.target);

    if (sourceId && targetId) {
      db.upsertRelationship(sourceId, targetId, rel.type, rel.description);
    }
  }

  // Store facts
  for (const fact of knowledge.facts) {
    db.insertFact({
      reelId,
      claim: fact.claim,
      confidence: fact.confidence,
      source: fact.source,
    });
  }

  return entityIdMap;
}

// ── Entity consolidation ─────────────────────────────────────────────────

/**
 * Compute edit distance (Levenshtein) between two strings.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimized: use single array
  const prev = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = prevDiag;
      } else {
        prev[j] = 1 + Math.min(prevDiag, prev[j - 1], prev[j]);
      }
      prevDiag = temp;
    }
  }

  return prev[n];
}

/**
 * Find near-duplicate entities and merge them.
 *
 * Strategy:
 * - Two entities are considered duplicates if their canonical names have
 *   edit distance <= 2, or if one is a substring of the other.
 * - When merging, the entity with the higher mention_count is kept.
 * - All reel_entities and relationships pointing to the merged entity
 *   are updated to point to the surviving entity.
 *
 * Returns the number of entities merged.
 */
export function consolidateEntities(db: KnowledgeDB): number {
  const allEntities = db.raw
    .prepare('SELECT id, canonical_name, display_name, type, mention_count FROM entities ORDER BY mention_count DESC')
    .all() as Array<{
      id: string;
      canonical_name: string;
      display_name: string;
      type: string;
      mention_count: number;
    }>;

  const merged = new Set<string>();
  let mergeCount = 0;

  for (let i = 0; i < allEntities.length; i++) {
    const entityA = allEntities[i];
    if (merged.has(entityA.id)) continue;

    for (let j = i + 1; j < allEntities.length; j++) {
      const entityB = allEntities[j];
      if (merged.has(entityB.id)) continue;

      // Only consider merging entities of the same type
      if (entityA.type !== entityB.type) continue;

      const nameA = entityA.canonical_name;
      const nameB = entityB.canonical_name;

      // Skip very short names to avoid false positives
      if (nameA.length < 3 || nameB.length < 3) continue;

      const isSubstring = nameA.includes(nameB) || nameB.includes(nameA);
      const distance = editDistance(nameA, nameB);
      const maxLen = Math.max(nameA.length, nameB.length);
      const threshold = maxLen <= 5 ? 1 : 2;

      if (isSubstring || distance <= threshold) {
        // Merge entityB into entityA (entityA has higher or equal mention_count)
        mergeEntity(db, entityA.id, entityB.id);
        merged.add(entityB.id);
        mergeCount++;
      }
    }
  }

  return mergeCount;
}

/**
 * Merge sourceEntity into targetEntity:
 * - Update reel_entities references
 * - Update relationship references
 * - Add source mention_count to target
 * - Delete the source entity
 */
function mergeEntity(db: KnowledgeDB, keepId: string, removeId: string): void {
  const raw = db.raw;

  // Update reel_entities: point to kept entity (ignore conflicts)
  raw.prepare(`
    UPDATE OR IGNORE reel_entities
    SET entity_id = ?
    WHERE entity_id = ?
  `).run(keepId, removeId);

  // Delete any reel_entities that now conflict
  raw.prepare('DELETE FROM reel_entities WHERE entity_id = ?').run(removeId);

  // Update relationships: source side
  raw.prepare(`
    UPDATE OR IGNORE relationships
    SET source_entity_id = ?
    WHERE source_entity_id = ?
  `).run(keepId, removeId);

  // Update relationships: target side
  raw.prepare(`
    UPDATE OR IGNORE relationships
    SET target_entity_id = ?
    WHERE target_entity_id = ?
  `).run(keepId, removeId);

  // Delete any relationships that now conflict or are self-referencing
  raw.prepare('DELETE FROM relationships WHERE source_entity_id = ? OR target_entity_id = ?')
    .run(removeId, removeId);
  raw.prepare('DELETE FROM relationships WHERE source_entity_id = target_entity_id')
    .run();

  // Add mention counts
  raw.prepare(`
    UPDATE entities
    SET mention_count = mention_count + (SELECT mention_count FROM entities WHERE id = ?)
    WHERE id = ?
  `).run(removeId, keepId);

  // Delete the merged entity
  raw.prepare('DELETE FROM entities WHERE id = ?').run(removeId);
}

// ── Neighbor queries ─────────────────────────────────────────────────────

/**
 * Get entities connected to the given entity via relationships (1 hop).
 */
export function getEntityNeighbors(
  db: KnowledgeDB,
  entityId: string,
): Array<{ entity: GraphNode; relationship: GraphEdge; direction: 'outgoing' | 'incoming' }> {
  const raw = db.raw;

  // Outgoing relationships
  const outgoing = raw.prepare(`
    SELECT
      e.id, e.canonical_name, e.display_name, e.type, e.mention_count,
      r.id AS rel_id, r.type AS rel_type, r.description AS rel_desc, r.evidence_count,
      r.source_entity_id, r.target_entity_id
    FROM relationships r
    JOIN entities e ON e.id = r.target_entity_id
    WHERE r.source_entity_id = ?
  `).all(entityId) as Array<Record<string, unknown>>;

  // Incoming relationships
  const incoming = raw.prepare(`
    SELECT
      e.id, e.canonical_name, e.display_name, e.type, e.mention_count,
      r.id AS rel_id, r.type AS rel_type, r.description AS rel_desc, r.evidence_count,
      r.source_entity_id, r.target_entity_id
    FROM relationships r
    JOIN entities e ON e.id = r.source_entity_id
    WHERE r.target_entity_id = ?
  `).all(entityId) as Array<Record<string, unknown>>;

  const results: Array<{ entity: GraphNode; relationship: GraphEdge; direction: 'outgoing' | 'incoming' }> = [];

  for (const row of outgoing) {
    results.push({
      entity: {
        id: row.id as string,
        name: (row.display_name as string) || (row.canonical_name as string),
        type: row.type as string,
        mentionCount: row.mention_count as number,
      },
      relationship: {
        id: row.rel_id as string,
        sourceId: row.source_entity_id as string,
        targetId: row.target_entity_id as string,
        type: row.rel_type as string,
        description: row.rel_desc as string,
        evidenceCount: row.evidence_count as number,
      },
      direction: 'outgoing',
    });
  }

  for (const row of incoming) {
    results.push({
      entity: {
        id: row.id as string,
        name: (row.display_name as string) || (row.canonical_name as string),
        type: row.type as string,
        mentionCount: row.mention_count as number,
      },
      relationship: {
        id: row.rel_id as string,
        sourceId: row.source_entity_id as string,
        targetId: row.target_entity_id as string,
        type: row.rel_type as string,
        description: row.rel_desc as string,
        evidenceCount: row.evidence_count as number,
      },
      direction: 'incoming',
    });
  }

  return results;
}

// ── Mention history ──────────────────────────────────────────────────────

/**
 * Return all reels that mention this entity, with timestamps and context.
 */
export function getEntityMentionHistory(
  db: KnowledgeDB,
  entityId: string,
): EntityMention[] {
  const rows = db.raw.prepare(`
    SELECT re.reel_id, r.shortcode, re.context, re.confidence, r.created_at
    FROM reel_entities re
    JOIN reels r ON r.id = re.reel_id
    WHERE re.entity_id = ?
    ORDER BY r.created_at DESC
  `).all(entityId) as Array<{
    reel_id: string;
    shortcode: string;
    context: string;
    confidence: number;
    created_at: string;
  }>;

  return rows.map(row => ({
    reelId: row.reel_id,
    shortcode: row.shortcode,
    context: row.context,
    confidence: row.confidence,
    createdAt: row.created_at,
  }));
}
