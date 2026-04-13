import type { QueryResult } from './engine.js';
import type { RankedReel } from './ranker.js';
import type { StoredEntity, StoredReel } from '../types.js';
import type { KnowledgeDB } from '../storage/db.js';
import type { GraphNode, GraphEdge } from '../graph/builder.js';
import type { ProjectRecommendation, RecommendationItem } from '../tools/recommend.js';
import type { DigestResult } from '../tools/digest.js';

// ── ANSI color helpers (same conventions as cli/main.ts) ─────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
};

function bold(s: string): string { return `${C.bold}${s}${C.reset}`; }
function green(s: string): string { return `${C.green}${s}${C.reset}`; }
function yellow(s: string): string { return `${C.yellow}${s}${C.reset}`; }
function blue(s: string): string { return `${C.blue}${s}${C.reset}`; }
function cyan(s: string): string { return `${C.cyan}${s}${C.reset}`; }
function dim(s: string): string { return `${C.dim}${s}${C.reset}`; }
function magenta(s: string): string { return `${C.magenta}${s}${C.reset}`; }

// ── Format options ───────────────────────────────────────────────────────

export interface FormatOptions {
  showScores?: boolean;
  showEntities?: boolean;
  showFacts?: boolean;
  maxSummaryLength?: number;
  db?: KnowledgeDB;
}

// ── Main result formatter ────────────────────────────────────────────────

/**
 * Pretty-print query results with ANSI colors.
 */
export function formatResults(
  results: QueryResult,
  opts: FormatOptions = {},
): string {
  const showScores = opts.showScores ?? true;
  const showEntities = opts.showEntities ?? true;
  const showFacts = opts.showFacts ?? true;
  const db = opts.db;

  const lines: string[] = [];

  lines.push(bold(`\n=== Search Results for "${results.query}" ===\n`));
  lines.push(`  ${bold('Results:')} ${results.totalResults}  ${dim(`(${results.timingMs}ms)`)}\n`);

  if (results.reels.length === 0) {
    lines.push(dim('  No results found.\n'));
    return lines.join('\n');
  }

  // Reel results
  for (let i = 0; i < results.reels.length; i++) {
    const ranked = results.reels[i];
    const reel = db?.getReelById(ranked.reelId);
    lines.push(formatReelSummary(ranked, reel, i + 1, showScores));
  }

  // Matched entities
  if (showEntities && results.entities.length > 0) {
    lines.push(bold('\n  --- Matched Entities ---\n'));
    for (const entity of results.entities.slice(0, 10)) {
      lines.push(`  ${cyan(entity.display_name)} ${dim(`[${entity.type}]`)} ${dim(`(${entity.mention_count} mentions)`)}`);
    }
    lines.push('');
  }

  // Matched facts
  if (showFacts && results.facts.length > 0) {
    lines.push(bold('\n  --- Related Facts ---\n'));
    for (const fact of results.facts.slice(0, 5)) {
      const conf = (fact.confidence * 100).toFixed(0);
      lines.push(`  ${yellow(`[${conf}%]`)} ${fact.claim}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Single reel formatter ────────────────────────────────────────────────

/**
 * Format a single ranked reel for display.
 */
export function formatReelSummary(
  ranked: RankedReel,
  reel?: StoredReel,
  index?: number,
  showScores: boolean = true,
): string {
  const lines: string[] = [];
  const prefix = index !== undefined ? `  ${bold(`${index}.`)} ` : '  ';

  if (reel) {
    const scoreStr = showScores
      ? ` ${dim(`[score: ${ranked.score.toFixed(3)}]`)}`
      : '';

    lines.push(
      `${prefix}${cyan(reel.shortcode)} ${dim('|')} ${reel.content_type.padEnd(22)} ${dim('|')} @${reel.author_id}${scoreStr}`,
    );

    const summary = reel.summary.slice(0, 120);
    lines.push(`     ${summary}${reel.summary.length > 120 ? '...' : ''}`);
    lines.push(`     ${dim(`URL: ${reel.url}`)}`);

    if (showScores) {
      const bd = ranked.scoreBreakdown;
      lines.push(
        `     ${dim(`V:${bd.vector.toFixed(2)} K:${bd.keyword.toFixed(2)} G:${bd.graph.toFixed(2)} R:${bd.recency.toFixed(2)}`)}`,
      );
    }
  } else {
    const scoreStr = showScores
      ? ` ${dim(`[score: ${ranked.score.toFixed(3)}]`)}`
      : '';
    lines.push(`${prefix}${dim(ranked.reelId)}${scoreStr}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Entity graph text visualization ──────────────────────────────────────

/**
 * Format an entity graph as a text-based visualization.
 * Shows the center node with connections radiating outward.
 */
export function formatEntityGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  centerEntityId?: string,
): string {
  if (nodes.length === 0) {
    return dim('  (empty graph)');
  }

  const lines: string[] = [];
  lines.push(bold('\n  === Entity Graph ===\n'));

  // Find center node
  const centerNode = centerEntityId
    ? nodes.find(n => n.id === centerEntityId)
    : nodes[0];

  if (centerNode) {
    lines.push(`  ${green(`[${centerNode.name}]`)} ${dim(`(${centerNode.type}, ${centerNode.mentionCount} mentions)`)}`);

    // Group edges by relationship type
    const edgesByType = new Map<string, Array<{ node: GraphNode; edge: GraphEdge; direction: string }>>();

    for (const edge of edges) {
      const isOutgoing = edge.sourceId === centerNode.id;
      const neighborId = isOutgoing ? edge.targetId : edge.sourceId;
      const neighborNode = nodes.find(n => n.id === neighborId);

      if (neighborNode) {
        const group = edgesByType.get(edge.type) ?? [];
        group.push({
          node: neighborNode,
          edge,
          direction: isOutgoing ? '->' : '<-',
        });
        edgesByType.set(edge.type, group);
      }
    }

    for (const [relType, group] of edgesByType) {
      lines.push(`  ${dim('|')}`);
      lines.push(`  ${dim('+-')} ${magenta(relType)}`);

      for (const { node, direction } of group) {
        const arrow = direction === '->' ? '-->' : '<--';
        lines.push(`  ${dim('|  ')} ${dim(arrow)} ${cyan(node.name)} ${dim(`[${node.type}]`)}`);
      }
    }

    // Show edges between non-center nodes
    const nonCenterEdges = edges.filter(
      e => e.sourceId !== centerNode.id && e.targetId !== centerNode.id,
    );

    if (nonCenterEdges.length > 0) {
      lines.push(`\n  ${dim('Other connections:')}`);
      for (const edge of nonCenterEdges) {
        const source = nodes.find(n => n.id === edge.sourceId);
        const target = nodes.find(n => n.id === edge.targetId);
        if (source && target) {
          lines.push(`    ${cyan(source.name)} ${dim(`--[${edge.type}]-->`)} ${cyan(target.name)}`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── Project recommendation formatter ─────────────────────────────────────

/**
 * Format project recommendation results with ANSI colors.
 */
export function formatRecommendation(rec: ProjectRecommendation): string {
  const lines: string[] = [];

  lines.push(bold(`\n=== Project Recommendations ===\n`));
  lines.push(`  ${bold('Project:')} ${rec.projectDescription}`);
  lines.push(`  ${bold('Matches:')} ${rec.totalMatches}  ${dim(`(${rec.queryTimeMs}ms)`)}\n`);

  if (rec.totalMatches === 0) {
    lines.push(dim('  No relevant recommendations found.\n'));
    return lines.join('\n');
  }

  const sections: Array<[string, RecommendationItem[]]> = [
    ['Repositories', rec.repos],
    ['Tools & Libraries', rec.tools],
    ['Techniques', rec.techniques],
    ['Workflows', rec.workflows],
    ['Architectures', rec.architectures],
  ];

  for (const [title, items] of sections) {
    if (items.length === 0) continue;

    lines.push(bold(`  --- ${title} ---\n`));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const scoreStr = dim(`[score: ${item.score.toFixed(3)}]`);
      const hypeStr = item.hypeLevel === 'grounded'
        ? green('grounded')
        : item.hypeLevel === 'moderate_hype'
          ? yellow('moderate')
          : `${C.red}high-hype${C.reset}`;
      const readinessStr = cyan(item.readiness);

      lines.push(`  ${bold(`${i + 1}.`)} ${cyan(item.name)} ${dim(`[${item.type}]`)} ${scoreStr}`);
      lines.push(`     ${item.description.slice(0, 120)}${item.description.length > 120 ? '...' : ''}`);
      lines.push(`     ${dim('Hype:')} ${hypeStr} ${dim('|')} ${dim('Readiness:')} ${readinessStr} ${dim('|')} ${dim('Mentions:')} ${item.mentionCount}`);

      if (item.provenanceReels.length > 0) {
        const provenance = item.provenanceReels
          .map(r => r.shortcode)
          .join(', ');
        lines.push(`     ${dim(`Source reels: ${provenance}`)}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Digest formatter ────────────────────────────────────────────────────

/**
 * Format a weekly/period digest with ANSI colors.
 */
export function formatDigest(digest: DigestResult): string {
  const lines: string[] = [];

  lines.push(bold(`\n=== Knowledge Digest: ${digest.period} ===\n`));
  lines.push(`  ${bold('Total Reels:')} ${digest.totalReels}`);
  lines.push(`  ${bold('Period:')} ${digest.startDate.slice(0, 10)} to ${digest.endDate.slice(0, 10)}`);
  lines.push(`\n  ${digest.summary}\n`);

  // Category breakdown
  if (Object.keys(digest.byCategory).length > 0) {
    lines.push(bold('  --- By Category ---\n'));
    const sorted = Object.entries(digest.byCategory).sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sorted) {
      const bar = '|'.repeat(Math.min(count * 2, 40));
      lines.push(`  ${cyan(cat.padEnd(25))} ${count.toString().padStart(3)} ${dim(bar)}`);
    }
    lines.push('');
  }

  // Top topics
  if (digest.topTopics.length > 0) {
    lines.push(bold('  --- Top Topics ---\n'));
    for (const topic of digest.topTopics.slice(0, 5)) {
      lines.push(`  ${cyan(topic.topic)} ${dim(`(${topic.reelCount} reels)`)}`);
    }
    lines.push('');
  }

  // Trending entities
  if (digest.trendingEntities.length > 0) {
    lines.push(bold('  --- Trending Entities ---\n'));
    for (const entity of digest.trendingEntities.slice(0, 10)) {
      const newBadge = entity.isNew ? ` ${green('NEW')}` : '';
      lines.push(
        `  ${cyan(entity.name)} ${dim(`[${entity.type}]`)} ${dim(`(${entity.mentionCount} mentions)`)}${newBadge}`,
      );
    }
    lines.push('');
  }

  // New entities
  if (digest.newEntities.length > 0) {
    lines.push(bold('  --- New Entities ---\n'));
    for (const entity of digest.newEntities.slice(0, 10)) {
      lines.push(`  ${green('+')} ${cyan(entity.name)} ${dim(`[${entity.type}]`)}`);
    }
    lines.push('');
  }

  // Top reels
  if (digest.topReels.length > 0) {
    lines.push(bold('  --- Top Reels ---\n'));
    for (let i = 0; i < Math.min(digest.topReels.length, 5); i++) {
      const reel = digest.topReels[i];
      lines.push(`  ${bold(`${i + 1}.`)} ${cyan(reel.shortcode)} ${dim(`[${reel.contentType}]`)} ${dim(`@${reel.author}`)}`);
      lines.push(`     ${reel.summary.slice(0, 120)}${reel.summary.length > 120 ? '...' : ''}`);
      lines.push(`     ${dim(reel.url)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Entity detail formatter ──────────────────────────────────────────────

/**
 * Format entity details for the `ke entity` command.
 */
export function formatEntityDetail(
  entity: StoredEntity,
  relationships: Array<{
    type: string;
    targetName: string;
    targetType: string;
    direction: string;
    evidenceCount: number;
  }>,
  reelCount: number,
): string {
  const lines: string[] = [];

  lines.push(bold(`\n=== Entity: ${entity.display_name} ===\n`));
  lines.push(`  ${bold('Type:')}         ${entity.type}`);
  lines.push(`  ${bold('Mentions:')}     ${entity.mention_count}`);
  lines.push(`  ${bold('First Seen:')}   ${entity.first_seen}`);
  lines.push(`  ${bold('Reels:')}        ${reelCount}`);

  if (entity.description) {
    lines.push(`  ${bold('Description:')}  ${entity.description}`);
  }

  const aliases = JSON.parse(entity.aliases) as string[];
  if (aliases.length > 0) {
    lines.push(`  ${bold('Aliases:')}      ${aliases.join(', ')}`);
  }

  if (relationships.length > 0) {
    lines.push(bold('\n  --- Relationships ---\n'));
    for (const rel of relationships) {
      const arrow = rel.direction === 'outgoing' ? '-->' : '<--';
      lines.push(
        `  ${dim(arrow)} ${magenta(rel.type)} ${cyan(rel.targetName)} ${dim(`[${rel.targetType}]`)} ${dim(`(${rel.evidenceCount}x)`)}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
