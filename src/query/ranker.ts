// ── Score fusion and ranking ─────────────────────────────────────────────

export interface ScoreBreakdown {
  vector: number;
  keyword: number;
  graph: number;
  recency: number;
  final: number;
}

export interface RankedReel {
  reelId: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface ScoredItem {
  reelId: string;
  score: number;
}

export interface FusionWeights {
  vector: number;
  keyword: number;
  graph: number;
  recency: number;
}

/** Default fusion weights. */
export const DEFAULT_WEIGHTS: FusionWeights = {
  vector: 0.4,
  keyword: 0.25,
  graph: 0.25,
  recency: 0.1,
};

/** Recency half-life in days. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Compute a recency score for a given date using exponential decay.
 * Score is 1.0 for "now" and decays with a 30-day half-life.
 */
export function computeRecencyScore(createdAt: string | Date): number {
  const date = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  const now = Date.now();
  const ageMs = now - date.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay: score = 0.5 ^ (ageDays / halfLife)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Fuse multiple scoring signals into a single ranked list.
 *
 * Each signal produces a list of {reelId, score} pairs where score is [0, 1].
 * Signals are combined using weighted sum, then normalized.
 *
 * @param vectorResults - Scores from vector similarity search
 * @param ftsResults - Scores from FTS5 keyword search
 * @param graphResults - Scores from entity graph matching
 * @param reelDates - Map of reelId -> created_at date string (for recency)
 * @param weights - Signal weights (default: vector=0.4, keyword=0.25, graph=0.25, recency=0.1)
 */
export function fuseScores(
  vectorResults: ScoredItem[],
  ftsResults: ScoredItem[],
  graphResults: ScoredItem[],
  reelDates: Map<string, string>,
  weights: FusionWeights = DEFAULT_WEIGHTS,
): RankedReel[] {
  // Collect all unique reel IDs
  const allReelIds = new Set<string>();
  for (const r of vectorResults) allReelIds.add(r.reelId);
  for (const r of ftsResults) allReelIds.add(r.reelId);
  for (const r of graphResults) allReelIds.add(r.reelId);

  // Build score lookup maps
  const vectorMap = new Map(vectorResults.map(r => [r.reelId, r.score]));
  const ftsMap = new Map(ftsResults.map(r => [r.reelId, r.score]));
  const graphMap = new Map(graphResults.map(r => [r.reelId, r.score]));

  // Normalize each signal to [0, 1] based on max value
  normalizeMap(vectorMap);
  normalizeMap(ftsMap);
  normalizeMap(graphMap);

  const ranked: RankedReel[] = [];

  for (const reelId of allReelIds) {
    const vectorScore = vectorMap.get(reelId) ?? 0;
    const keywordScore = ftsMap.get(reelId) ?? 0;
    const graphScore = graphMap.get(reelId) ?? 0;

    const dateStr = reelDates.get(reelId);
    const recencyScore = dateStr ? computeRecencyScore(dateStr) : 0.5;

    const finalScore =
      weights.vector * vectorScore +
      weights.keyword * keywordScore +
      weights.graph * graphScore +
      weights.recency * recencyScore;

    ranked.push({
      reelId,
      score: finalScore,
      scoreBreakdown: {
        vector: vectorScore,
        keyword: keywordScore,
        graph: graphScore,
        recency: recencyScore,
        final: finalScore,
      },
    });
  }

  // Sort by final score descending
  ranked.sort((a, b) => b.score - a.score);

  return ranked;
}

/**
 * Normalize all values in a Map to [0, 1] range based on the max value.
 */
function normalizeMap(map: Map<string, number>): void {
  if (map.size === 0) return;

  let maxVal = 0;
  for (const v of map.values()) {
    if (v > maxVal) maxVal = v;
  }

  if (maxVal > 0) {
    for (const [k, v] of map) {
      map.set(k, v / maxVal);
    }
  }
}
