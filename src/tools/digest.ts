import type { KnowledgeDB } from '../storage/db.js';
import type { StoredReel, StoredEntity } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface DigestTopicGroup {
  topic: string;
  reelCount: number;
  reels: Array<{ shortcode: string; url: string; summary: string }>;
}

export interface DigestEntity {
  name: string;
  type: string;
  mentionCount: number;
  isNew: boolean;
}

export interface DigestReel {
  shortcode: string;
  url: string;
  summary: string;
  contentType: string;
  author: string;
  score: number;
}

export interface DigestResult {
  /** Period description (e.g., "Last 7 days") */
  period: string;
  /** Start date of the period */
  startDate: string;
  /** End date of the period */
  endDate: string;
  /** Total reels ingested in the period */
  totalReels: number;
  /** Topics with the most reels in the period */
  topTopics: DigestTopicGroup[];
  /** Entities trending in the period */
  trendingEntities: DigestEntity[];
  /** Entities first seen during this period */
  newEntities: DigestEntity[];
  /** Highest-scoring reels in the period */
  topReels: DigestReel[];
  /** Reels grouped by content category */
  byCategory: Record<string, number>;
  /** Brief summary text */
  summary: string;
}

// ── Digest generation ───────────────────────────────────────────────────

/**
 * Generate a digest of knowledge base activity over a given period.
 *
 * Groups reels by category and topic, highlights new entities,
 * and ranks reels by a combined score of view count, entity density,
 * and actionability.
 *
 * @param db    Knowledge database
 * @param days  Number of days to look back (default: 7)
 */
export function generateDigest(
  db: KnowledgeDB,
  days: number = 7,
): DigestResult {
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const periodStr = days === 7 ? 'Last 7 days' : `Last ${days} days`;

  // 1. Get reels from the period
  const reels = db.raw.prepare(`
    SELECT * FROM reels
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
  `).all(days) as StoredReel[];

  // 2. Category breakdown
  const byCategory: Record<string, number> = {};
  for (const reel of reels) {
    byCategory[reel.content_type] = (byCategory[reel.content_type] ?? 0) + 1;
  }

  // 3. Top topics in the period
  const topTopicRows = db.raw.prepare(`
    SELECT t.name, COUNT(rt.reel_id) as reel_count
    FROM reel_topics rt
    JOIN topics t ON t.id = rt.topic_id
    JOIN reels r ON r.id = rt.reel_id
    WHERE r.created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY t.id
    ORDER BY reel_count DESC
    LIMIT 10
  `).all(days) as Array<{ name: string; reel_count: number }>;

  const topTopics: DigestTopicGroup[] = topTopicRows.map(row => {
    // Get reels for this topic
    const topicReels = db.raw.prepare(`
      SELECT r.shortcode, r.url, r.summary
      FROM reel_topics rt
      JOIN topics t ON t.id = rt.topic_id
      JOIN reels r ON r.id = rt.reel_id
      WHERE t.name = ? AND r.created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY r.created_at DESC
      LIMIT 5
    `).all(row.name, days) as Array<{ shortcode: string; url: string; summary: string }>;

    return {
      topic: row.name,
      reelCount: row.reel_count,
      reels: topicReels,
    };
  });

  // 4. Trending entities
  const trendingRows = db.raw.prepare(`
    SELECT
      e.id, e.display_name, e.canonical_name, e.type, e.mention_count, e.first_seen,
      COUNT(re.reel_id) AS recent_mentions
    FROM entities e
    JOIN reel_entities re ON re.entity_id = e.id
    JOIN reels r ON r.id = re.reel_id
    WHERE r.created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY e.id
    ORDER BY recent_mentions DESC
    LIMIT 15
  `).all(days) as Array<{
    id: string;
    display_name: string;
    canonical_name: string;
    type: string;
    mention_count: number;
    first_seen: string;
    recent_mentions: number;
  }>;

  const trendingEntities: DigestEntity[] = trendingRows.map(row => ({
    name: row.display_name || row.canonical_name,
    type: row.type,
    mentionCount: row.recent_mentions,
    isNew: new Date(row.first_seen) >= startDate,
  }));

  // 5. New entities (first seen during this period)
  const newEntityRows = db.raw.prepare(`
    SELECT display_name, canonical_name, type, mention_count
    FROM entities
    WHERE first_seen >= datetime('now', '-' || ? || ' days')
    ORDER BY mention_count DESC
    LIMIT 20
  `).all(days) as Array<{
    display_name: string;
    canonical_name: string;
    type: string;
    mention_count: number;
  }>;

  const newEntities: DigestEntity[] = newEntityRows.map(row => ({
    name: row.display_name || row.canonical_name,
    type: row.type,
    mentionCount: row.mention_count,
    isNew: true,
  }));

  // 6. Top reels (scored by view_count + entity density + actionability)
  const topReels: DigestReel[] = reels
    .map(reel => {
      // Entity density: how many entities are linked to this reel
      const entityCount = (db.raw.prepare(
        'SELECT COUNT(*) as c FROM reel_entities WHERE reel_id = ?',
      ).get(reel.id) as { c: number }).c;

      // Actionability: number of action items
      let actionItems: string[] = [];
      try {
        actionItems = JSON.parse(reel.action_items) as string[];
      } catch {
        // ignore
      }

      // Combined score
      const viewScore = Math.log10(Math.max(reel.view_count, 1)) / 10;
      const entityDensityScore = Math.min(entityCount / 5, 1.0);
      const actionScore = Math.min(actionItems.length / 3, 1.0);

      const score =
        viewScore * 0.3 +
        entityDensityScore * 0.4 +
        actionScore * 0.3;

      return {
        shortcode: reel.shortcode,
        url: reel.url,
        summary: reel.summary,
        contentType: reel.content_type,
        author: reel.author_id,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // 7. Generate summary text
  const summaryParts: string[] = [];
  summaryParts.push(`${reels.length} reels ingested in the ${periodStr.toLowerCase()}.`);

  if (Object.keys(byCategory).length > 0) {
    const topCat = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, count]) => `${cat} (${count})`)
      .join(', ');
    summaryParts.push(`Top categories: ${topCat}.`);
  }

  if (newEntities.length > 0) {
    summaryParts.push(`${newEntities.length} new entities discovered.`);
  }

  if (trendingEntities.length > 0) {
    const topNames = trendingEntities
      .slice(0, 3)
      .map(e => e.name)
      .join(', ');
    summaryParts.push(`Trending: ${topNames}.`);
  }

  return {
    period: periodStr,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    totalReels: reels.length,
    topTopics,
    trendingEntities,
    newEntities,
    topReels,
    byCategory,
    summary: summaryParts.join(' '),
  };
}
