import type { KnowledgeDB } from '../storage/db.js';
import type { StoredEntity, StoredReel, HypeLevel, ImplementationReadiness } from '../types.js';
import { queryKnowledge } from '../query/engine.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface RecommendationItem {
  name: string;
  type: string;
  description: string;
  score: number;
  mentionCount: number;
  hypeLevel: HypeLevel;
  readiness: ImplementationReadiness;
  provenanceReels: Array<{ shortcode: string; url: string; summary: string }>;
}

export interface ProjectRecommendation {
  projectDescription: string;
  repos: RecommendationItem[];
  tools: RecommendationItem[];
  techniques: RecommendationItem[];
  workflows: RecommendationItem[];
  architectures: RecommendationItem[];
  totalMatches: number;
  queryTimeMs: number;
}

export interface RecommendOptions {
  maxPerCategory?: number;
  preferGrounded?: boolean;
  preferProduction?: boolean;
  minMentions?: number;
}

// ── Scoring helpers ─────────────────────────────────────────────────────

const HYPE_SCORES: Record<HypeLevel, number> = {
  grounded: 1.0,
  moderate_hype: 0.6,
  high_hype: 0.3,
};

const READINESS_SCORES: Record<ImplementationReadiness, number> = {
  production: 1.0,
  beta: 0.8,
  alpha: 0.5,
  research: 0.3,
  concept: 0.1,
};

/**
 * Score a recommendation based on multiple signals:
 * - Base relevance from query match
 * - Hype filtering (grounded > moderate > high hype)
 * - Implementation readiness (production > beta > alpha > research > concept)
 * - Frequency of mentions (more mentions = more trusted)
 */
function scoreRecommendation(
  entity: StoredEntity,
  matchingReels: StoredReel[],
  opts: RecommendOptions,
): number {
  const preferGrounded = opts.preferGrounded ?? true;
  const preferProduction = opts.preferProduction ?? true;

  // Base score from mention count (logarithmic to avoid runaway scores)
  const mentionScore = Math.log2(entity.mention_count + 1) / 10;

  // Hype filtering: average hype level across matching reels
  let hypeScore = 0.5;
  if (preferGrounded && matchingReels.length > 0) {
    const totalHype = matchingReels.reduce((sum, r) => {
      return sum + (HYPE_SCORES[r.hype_level as HypeLevel] ?? 0.5);
    }, 0);
    hypeScore = totalHype / matchingReels.length;
  }

  // Readiness filtering: average readiness across matching reels
  let readinessScore = 0.5;
  if (preferProduction && matchingReels.length > 0) {
    const totalReadiness = matchingReels.reduce((sum, r) => {
      return sum + (READINESS_SCORES[r.implementation_readiness as ImplementationReadiness] ?? 0.5);
    }, 0);
    readinessScore = totalReadiness / matchingReels.length;
  }

  // Combined score with weights
  return (
    mentionScore * 0.3 +
    hypeScore * 0.35 +
    readinessScore * 0.35
  );
}

// ── Provenance lookup ───────────────────────────────────────────────────

/**
 * Get the reels that mention a specific entity (for provenance tracking).
 */
function getEntityReels(
  db: KnowledgeDB,
  entityId: string,
  limit: number = 5,
): Array<{ shortcode: string; url: string; summary: string }> {
  const rows = db.raw.prepare(`
    SELECT r.shortcode, r.url, r.summary
    FROM reel_entities re
    JOIN reels r ON r.id = re.reel_id
    WHERE re.entity_id = ?
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(entityId, limit) as Array<{
    shortcode: string;
    url: string;
    summary: string;
  }>;

  return rows;
}

/**
 * Get matching reels for an entity (for hype/readiness scoring).
 */
function getMatchingReels(
  db: KnowledgeDB,
  entityId: string,
): StoredReel[] {
  return db.raw.prepare(`
    SELECT r.*
    FROM reel_entities re
    JOIN reels r ON r.id = re.reel_id
    WHERE re.entity_id = ?
    ORDER BY r.created_at DESC
    LIMIT 10
  `).all(entityId) as StoredReel[];
}

// ── Main recommendation engine ──────────────────────────────────────────

/**
 * Generate project-mode recommendations based on a project description.
 *
 * Uses the query engine + entity graph + hype filtering to find
 * relevant repos, tools, techniques, workflows, and architectures.
 *
 * Prioritizes:
 * - Grounded over hype
 * - Production-ready over research
 * - Frequently-mentioned over one-off
 *
 * Each recommendation includes provenance (which reel mentioned it).
 */
export function getProjectRecommendations(
  db: KnowledgeDB,
  projectDescription: string,
  opts: RecommendOptions = {},
): ProjectRecommendation {
  const start = Date.now();
  const maxPerCategory = opts.maxPerCategory ?? 5;
  const minMentions = opts.minMentions ?? 1;

  // Step 1: Query the knowledge base for relevant reels
  const queryResult = queryKnowledge(db, projectDescription, {
    limit: 50,
    includeEntities: true,
    includeFacts: true,
  });

  // Step 2: Collect all entities from matched reels + direct entity search
  const entityMap = new Map<string, StoredEntity>();

  // From query result entities
  for (const entity of queryResult.entities) {
    entityMap.set(entity.id, entity);
  }

  // From matched reels -- get their linked entities
  for (const rankedReel of queryResult.reels.slice(0, 20)) {
    const reelEntities = db.getEntitiesForReel(rankedReel.reelId);
    for (const entity of reelEntities) {
      entityMap.set(entity.id, entity);
    }
  }

  // Also search entities directly by keywords from the description
  const keywords = projectDescription
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);

  for (const keyword of keywords.slice(0, 10)) {
    const searchResults = db.searchEntities(keyword, 10);
    for (const entity of searchResults) {
      entityMap.set(entity.id, entity);
    }
  }

  // Step 3: Score and categorize entities
  const categories: Record<string, RecommendationItem[]> = {
    repos: [],
    tools: [],
    techniques: [],
    workflows: [],
    architectures: [],
  };

  const typeToCategory: Record<string, string> = {
    repository: 'repos',
    tool: 'tools',
    library: 'tools',
    framework: 'tools',
    technique: 'techniques',
    workflow: 'workflows',
    architecture: 'architectures',
    model: 'tools',
  };

  for (const entity of entityMap.values()) {
    if (entity.mention_count < minMentions) continue;

    const category = typeToCategory[entity.type];
    if (!category) continue;

    const matchingReels = getMatchingReels(db, entity.id);
    const score = scoreRecommendation(entity, matchingReels, opts);
    const provenanceReels = getEntityReels(db, entity.id, 3);

    // Determine dominant hype level and readiness from associated reels
    const dominantHype = getDominantValue(
      matchingReels.map(r => r.hype_level),
      'grounded',
    ) as HypeLevel;
    const dominantReadiness = getDominantValue(
      matchingReels.map(r => r.implementation_readiness),
      'concept',
    ) as ImplementationReadiness;

    categories[category].push({
      name: entity.display_name,
      type: entity.type,
      description: entity.description,
      score,
      mentionCount: entity.mention_count,
      hypeLevel: dominantHype,
      readiness: dominantReadiness,
      provenanceReels,
    });
  }

  // Step 4: Sort each category by score and trim
  for (const key of Object.keys(categories)) {
    categories[key].sort((a, b) => b.score - a.score);
    categories[key] = categories[key].slice(0, maxPerCategory);
  }

  const totalMatches =
    categories.repos.length +
    categories.tools.length +
    categories.techniques.length +
    categories.workflows.length +
    categories.architectures.length;

  return {
    projectDescription,
    repos: categories.repos,
    tools: categories.tools,
    techniques: categories.techniques,
    workflows: categories.workflows,
    architectures: categories.architectures,
    totalMatches,
    queryTimeMs: Date.now() - start,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Get the most common value from an array (mode).
 */
function getDominantValue(values: string[], fallback: string): string {
  if (values.length === 0) return fallback;

  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }

  let maxCount = 0;
  let dominant = fallback;
  for (const [val, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      dominant = val;
    }
  }

  return dominant;
}
