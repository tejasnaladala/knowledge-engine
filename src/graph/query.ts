import type { KnowledgeDB } from '../storage/db.js';
import type { GraphNode, GraphEdge } from './builder.js';

// ── Return types ─────────────────────────────────────────────────────────

export interface TraversalNode extends GraphNode {
  depth: number;
  path: string[];
}

export interface EntitySubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  centerEntityId: string;
}

export interface CommonEntity {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  reelIds: string[];
}

export interface TrendingEntity {
  id: string;
  name: string;
  type: string;
  recentMentions: number;
  totalMentions: number;
}

// ── BFS traversal ────────────────────────────────────────────────────────

/**
 * Find entities related to the given entity name using breadth-first search.
 * Traverses through relationships up to `maxDepth` hops.
 */
export function findRelatedEntities(
  db: KnowledgeDB,
  entityName: string,
  maxDepth: number = 2,
): TraversalNode[] {
  const raw = db.raw;

  // Find the starting entity
  const startEntity = raw
    .prepare('SELECT id, canonical_name, display_name, type, mention_count FROM entities WHERE canonical_name = ?')
    .get(entityName.toLowerCase().trim()) as {
      id: string;
      canonical_name: string;
      display_name: string;
      type: string;
      mention_count: number;
    } | undefined;

  if (!startEntity) {
    return [];
  }

  const visited = new Set<string>();
  visited.add(startEntity.id);

  const results: TraversalNode[] = [];

  // BFS queue: [entityId, depth, path]
  const queue: Array<[string, number, string[]]> = [
    [startEntity.id, 0, [startEntity.display_name || startEntity.canonical_name]],
  ];

  while (queue.length > 0) {
    const [currentId, depth, path] = queue.shift()!;

    if (depth >= maxDepth) continue;

    // Get neighbors (both directions)
    const neighbors = raw.prepare(`
      SELECT e.id, e.canonical_name, e.display_name, e.type, e.mention_count
      FROM relationships r
      JOIN entities e ON e.id = CASE
        WHEN r.source_entity_id = ? THEN r.target_entity_id
        ELSE r.source_entity_id
      END
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
    `).all(currentId, currentId, currentId) as Array<{
      id: string;
      canonical_name: string;
      display_name: string;
      type: string;
      mention_count: number;
    }>;

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);

      const name = neighbor.display_name || neighbor.canonical_name;
      const newPath = [...path, name];

      results.push({
        id: neighbor.id,
        name,
        type: neighbor.type,
        mentionCount: neighbor.mention_count,
        depth: depth + 1,
        path: newPath,
      });

      queue.push([neighbor.id, depth + 1, newPath]);
    }
  }

  return results;
}

// ── Common entities across reels ─────────────────────────────────────────

/**
 * Find entities that appear in multiple specified reels.
 * Returns entities shared across at least 2 of the given reel IDs.
 */
export function findCommonEntities(
  db: KnowledgeDB,
  reelIds: string[],
): CommonEntity[] {
  if (reelIds.length < 2) return [];

  const raw = db.raw;
  const placeholders = reelIds.map(() => '?').join(', ');

  const rows = raw.prepare(`
    SELECT
      e.id, e.canonical_name, e.display_name, e.type, e.mention_count,
      GROUP_CONCAT(re.reel_id) AS reel_id_list,
      COUNT(DISTINCT re.reel_id) AS shared_count
    FROM reel_entities re
    JOIN entities e ON e.id = re.entity_id
    WHERE re.reel_id IN (${placeholders})
    GROUP BY e.id
    HAVING shared_count >= 2
    ORDER BY shared_count DESC, e.mention_count DESC
  `).all(...reelIds) as Array<{
    id: string;
    canonical_name: string;
    display_name: string;
    type: string;
    mention_count: number;
    reel_id_list: string;
    shared_count: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    name: row.display_name || row.canonical_name,
    type: row.type,
    mentionCount: row.mention_count,
    reelIds: row.reel_id_list.split(','),
  }));
}

// ── Trending entities ────────────────────────────────────────────────────

/**
 * Get entities with the most mentions in the given recent period.
 */
export function getTrendingEntities(
  db: KnowledgeDB,
  days: number = 7,
): TrendingEntity[] {
  const rows = db.raw.prepare(`
    SELECT
      e.id, e.canonical_name, e.display_name, e.type, e.mention_count,
      COUNT(re.reel_id) AS recent_mentions
    FROM entities e
    JOIN reel_entities re ON re.entity_id = e.id
    JOIN reels r ON r.id = re.reel_id
    WHERE r.created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY e.id
    ORDER BY recent_mentions DESC, e.mention_count DESC
    LIMIT 20
  `).all(days) as Array<{
    id: string;
    canonical_name: string;
    display_name: string;
    type: string;
    mention_count: number;
    recent_mentions: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    name: row.display_name || row.canonical_name,
    type: row.type,
    recentMentions: row.recent_mentions,
    totalMentions: row.mention_count,
  }));
}

// ── Entity subgraph ──────────────────────────────────────────────────────

/**
 * Get the full subgraph around an entity (nodes + edges) for visualization.
 * Includes the center entity, all direct neighbors, and all edges between them.
 */
export function getEntityGraph(
  db: KnowledgeDB,
  entityName: string,
): EntitySubgraph | null {
  const raw = db.raw;

  // Find center entity
  const center = raw
    .prepare('SELECT id, canonical_name, display_name, type, mention_count FROM entities WHERE canonical_name = ?')
    .get(entityName.toLowerCase().trim()) as {
      id: string;
      canonical_name: string;
      display_name: string;
      type: string;
      mention_count: number;
    } | undefined;

  if (!center) return null;

  const nodes: GraphNode[] = [{
    id: center.id,
    name: center.display_name || center.canonical_name,
    type: center.type,
    mentionCount: center.mention_count,
  }];

  const nodeIds = new Set<string>([center.id]);

  // Get all edges connected to center
  const edges: GraphEdge[] = [];

  const relRows = raw.prepare(`
    SELECT id, source_entity_id, target_entity_id, type, description, evidence_count
    FROM relationships
    WHERE source_entity_id = ? OR target_entity_id = ?
  `).all(center.id, center.id) as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    type: string;
    description: string;
    evidence_count: number;
  }>;

  for (const rel of relRows) {
    edges.push({
      id: rel.id,
      sourceId: rel.source_entity_id,
      targetId: rel.target_entity_id,
      type: rel.type,
      description: rel.description,
      evidenceCount: rel.evidence_count,
    });

    // Add neighbor nodes
    const neighborId = rel.source_entity_id === center.id
      ? rel.target_entity_id
      : rel.source_entity_id;

    if (!nodeIds.has(neighborId)) {
      nodeIds.add(neighborId);
      const neighbor = raw
        .prepare('SELECT id, canonical_name, display_name, type, mention_count FROM entities WHERE id = ?')
        .get(neighborId) as {
          id: string;
          canonical_name: string;
          display_name: string;
          type: string;
          mention_count: number;
        } | undefined;

      if (neighbor) {
        nodes.push({
          id: neighbor.id,
          name: neighbor.display_name || neighbor.canonical_name,
          type: neighbor.type,
          mentionCount: neighbor.mention_count,
        });
      }
    }
  }

  // Also get edges between neighbor nodes (for a richer subgraph)
  const neighborIds = [...nodeIds].filter(id => id !== center.id);
  if (neighborIds.length > 1) {
    const placeholders = neighborIds.map(() => '?').join(', ');
    const interEdges = raw.prepare(`
      SELECT id, source_entity_id, target_entity_id, type, description, evidence_count
      FROM relationships
      WHERE source_entity_id IN (${placeholders})
        AND target_entity_id IN (${placeholders})
    `).all(...neighborIds, ...neighborIds) as Array<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
      type: string;
      description: string;
      evidence_count: number;
    }>;

    const edgeIds = new Set(edges.map(e => e.id));
    for (const rel of interEdges) {
      if (!edgeIds.has(rel.id)) {
        edges.push({
          id: rel.id,
          sourceId: rel.source_entity_id,
          targetId: rel.target_entity_id,
          type: rel.type,
          description: rel.description,
          evidenceCount: rel.evidence_count,
        });
      }
    }
  }

  return {
    nodes,
    edges,
    centerEntityId: center.id,
  };
}
