/**
 * Knowledge Engine -- OpenClaw Plugin Entry Point
 *
 * Registers agent tools, CLI commands, lifecycle hooks, and a background
 * inbox-watcher service with the OpenClaw runtime.
 *
 * Tools:
 *   ke_ingest  - Ingest a reel from an Instagram URL
 *   ke_search  - Full-text search across the knowledge base
 *   ke_graph   - Explore entity relationships in the knowledge graph
 *   ke_stats   - Show knowledge base statistics
 *
 * CLI:
 *   openclaw ke ingest <url>
 *   openclaw ke search <query>
 *   openclaw ke stats
 *   openclaw ke scan
 *
 * Hooks:
 *   message_received - auto-detect Instagram reel URLs and queue for ingestion
 *
 * Service:
 *   inbox-watcher - watches data/inbox/ for new URL files
 */

import path from 'path';
import { Type } from '@sinclair/typebox';

import { KnowledgeDB } from './src/storage/db.js';
import { storeExtractionResult, storeUnifiedResult } from './src/storage/store.js';
import { extractFromReel } from './src/extraction/pipeline.js';
import { getEntityGraph, findRelatedEntities } from './src/graph/query.js';
import { detectContentUrls, queueContentForProcessing } from './src/hooks/auto-capture.js';
import { startInboxWatcher, stopInboxWatcher } from './src/ingestion/watcher.js';
import { getProjectRecommendations } from './src/tools/recommend.js';
import { generateDigest } from './src/tools/digest.js';
import { formatRecommendation, formatDigest } from './src/query/formatter.js';
import { ingestContent } from './src/extraction/unified-pipeline.js';
import { classifyUrl } from './src/ingestion/url-router.js';

import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  AnyAgentTool,
} from './src/plugin-types.js';

import type { PipelineConfig, KnowledgeStats, StoredReel, SourceType } from './src/types.js';

// ── Config helpers ───────────────────────────────────────────────────────

interface PluginConfig {
  dbPath: string;
  mediaDir: string;
  inboxDir: string;
  whisperModel: string;
  autoRecall: boolean;
  maxOcrFrames: number;
}

const DEFAULTS: PluginConfig = {
  dbPath: 'data/knowledge.sqlite',
  mediaDir: 'data/processed',
  inboxDir: 'data/inbox',
  whisperModel: 'base',
  autoRecall: true,
  maxOcrFrames: 5,
};

function resolveConfig(raw?: Record<string, unknown>): PluginConfig {
  return {
    dbPath: (raw?.dbPath as string) ?? DEFAULTS.dbPath,
    mediaDir: (raw?.mediaDir as string) ?? DEFAULTS.mediaDir,
    inboxDir: (raw?.inboxDir as string) ?? DEFAULTS.inboxDir,
    whisperModel: (raw?.whisperModel as string) ?? DEFAULTS.whisperModel,
    autoRecall: (raw?.autoRecall as boolean) ?? DEFAULTS.autoRecall,
    maxOcrFrames: (raw?.maxOcrFrames as number) ?? DEFAULTS.maxOcrFrames,
  };
}

// ── Lazy DB factory ──────────────────────────────────────────────────────

function openDB(dbPath: string): KnowledgeDB {
  const db = new KnowledgeDB(dbPath);
  db.init();
  return db;
}

// ── Plugin definition ────────────────────────────────────────────────────

const knowledgeEnginePlugin: OpenClawPluginDefinition = {
  id: 'knowledge-engine',
  name: 'Knowledge Engine',
  description:
    'Personal AI knowledge engine for Instagram reels - extracts, organizes, and queries knowledge from video content',

  configSchema: {
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dbPath: { type: 'string', description: 'Path to knowledge SQLite database' },
        mediaDir: { type: 'string', description: 'Directory for downloaded media files' },
        inboxDir: { type: 'string', description: 'Drop folder for reel URLs to ingest' },
        whisperModel: { type: 'string', description: 'Whisper model size (base/small/medium)' },
        autoRecall: { type: 'boolean', description: 'Auto-inject relevant knowledge into context' },
        maxOcrFrames: { type: 'number', description: 'Max frames for OCR extraction' },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);

    // Resolve paths relative to plugin source (project root)
    const projectRoot = path.resolve(import.meta.dirname);
    const dbPath = path.isAbsolute(cfg.dbPath)
      ? cfg.dbPath
      : path.join(projectRoot, cfg.dbPath);
    const mediaDir = path.isAbsolute(cfg.mediaDir)
      ? cfg.mediaDir
      : path.join(projectRoot, cfg.mediaDir);
    const inboxDir = path.isAbsolute(cfg.inboxDir)
      ? cfg.inboxDir
      : path.join(projectRoot, cfg.inboxDir);

    const pipelineConfig: PipelineConfig = {
      mediaDir,
      whisperModel: cfg.whisperModel,
      maxOcrFrames: cfg.maxOcrFrames,
    };

    api.logger.info(
      `knowledge-engine: registered (db: ${dbPath}, inbox: ${inboxDir})`,
    );

    // ====================================================================
    // Tool: ke_ingest
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_ingest',
        label: 'Knowledge Engine: Ingest Content',
        description:
          'Ingest content from any URL -- Instagram reels, YouTube videos, GitHub repos, ' +
          'Reddit posts, Hacker News threads, arXiv papers, TikTok, Twitter/X posts, ' +
          'or any web article. Automatically detects the content type and uses the ' +
          'appropriate extraction pipeline. Returns extracted knowledge with entities, ' +
          'facts, and topics.',
        parameters: Type.Object({
          url: Type.String({ description: 'URL to ingest (any platform supported)' }),
        }),
        async execute(_toolCallId, params) {
          const { url } = params as { url: string };
          const db = openDB(dbPath);

          try {
            // Check for duplicate
            if (db.reelExists(url)) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Content already exists in the knowledge base. URL: ${url}`,
                  },
                ],
              };
            }

            // Classify URL and run unified pipeline
            const { sourceType, identifier } = classifyUrl(url);
            const result = await ingestContent(url, sourceType, identifier, pipelineConfig);

            // Store results
            const reelId = storeUnifiedResult(db, result);

            const summary = [
              `Successfully ingested ${sourceType} content`,
              '',
              `ID: ${reelId}`,
              `Source: ${sourceType}`,
              `Content Type: ${result.knowledge.contentType}`,
              `Sentiment: ${result.knowledge.sentiment}`,
              `Hype Level: ${result.knowledge.hypeLevel}`,
              `Implementation Readiness: ${result.knowledge.implementationReadiness}`,
              '',
              `Summary: ${result.knowledge.summary}`,
              '',
              `Entities (${result.knowledge.entities.length}):`,
              ...result.knowledge.entities.map(
                e => `  - ${e.name} (${e.type}): ${e.description}`,
              ),
              '',
              `Facts (${result.knowledge.facts.length}):`,
              ...result.knowledge.facts.map(
                f => `  - ${f.claim} (confidence: ${f.confidence}, source: ${f.source})`,
              ),
              '',
              `Topics: ${result.knowledge.topics.join(', ')}`,
              `Tags: ${result.knowledge.tags.join(', ')}`,
              `Processing Time: ${(result.processingTimeMs / 1000).toFixed(1)}s`,
            ].join('\n');

            return {
              content: [{ type: 'text' as const, text: summary }],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_ingest' },
    );

    // ====================================================================
    // Tool: ke_search
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_search',
        label: 'Knowledge Engine: Search',
        description:
          'Search the knowledge base using full-text search. Finds reels matching ' +
          'the query across summaries, transcripts, OCR text, and metadata. ' +
          'Returns matching reels with provenance (author, URL, content type). ' +
          'Optionally filter by content category.',
        parameters: Type.Object({
          query: Type.String({ description: 'Search query' }),
          limit: Type.Optional(
            Type.Number({ description: 'Max results to return (default: 10)' }),
          ),
          category: Type.Optional(
            Type.String({
              description:
                'Filter by content type: repo_recommendation, tutorial, news_update, ' +
                'tool_review, research_insight, workflow_tip, product_idea, ' +
                'engineering_trick, ai_technique, general',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 10,
            category,
          } = params as { query: string; limit?: number; category?: string };
          const db = openDB(dbPath);

          try {
            let results: StoredReel[] = db.searchReelsFTS(query, limit * 2);

            // Filter by category if specified
            if (category) {
              results = results.filter(r => r.content_type === category);
            }

            // Trim to limit
            results = results.slice(0, limit);

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No results found for "${query}"${category ? ` in category "${category}"` : ''}.`,
                  },
                ],
              };
            }

            const formatted = results
              .map((r, i) => {
                const lines = [
                  `${i + 1}. [${r.content_type}] ${r.summary.slice(0, 200)}`,
                  `   Author: @${r.author_id} | Shortcode: ${r.shortcode}`,
                  `   URL: ${r.url}`,
                  `   Sentiment: ${r.sentiment} | Hype: ${r.hype_level} | Readiness: ${r.implementation_readiness}`,
                  `   Ingested: ${r.created_at}`,
                ];
                return lines.join('\n');
              })
              .join('\n\n');

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Found ${results.length} result(s) for "${query}":\n\n${formatted}`,
                },
              ],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_search' },
    );

    // ====================================================================
    // Tool: ke_graph
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_graph',
        label: 'Knowledge Engine: Entity Graph',
        description:
          'Explore the knowledge graph around an entity. Returns the entity, its ' +
          'direct relationships to other entities, and the relationship types ' +
          '(e.g., "recommends", "replaces", "integrates_with"). ' +
          'Useful for understanding how tools, libraries, and concepts relate.',
        parameters: Type.Object({
          entity: Type.String({
            description: 'Entity name to look up (e.g., "LangChain", "GPT-4")',
          }),
        }),
        async execute(_toolCallId, params) {
          const { entity } = params as { entity: string };
          const db = openDB(dbPath);

          try {
            // Get full subgraph
            const subgraph = getEntityGraph(db, entity);

            if (!subgraph) {
              // Try finding related via BFS in case of partial match
              const related = findRelatedEntities(db, entity, 1);
              if (related.length === 0) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Entity "${entity}" not found in the knowledge graph.`,
                    },
                  ],
                };
              }

              const list = related
                .map(r => `  - ${r.name} (${r.type}, ${r.mentionCount} mentions)`)
                .join('\n');
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Partial match -- related entities for "${entity}":\n${list}`,
                  },
                ],
              };
            }

            // Format nodes
            const nodeList = subgraph.nodes
              .map(n => `  - ${n.name} (${n.type}, ${n.mentionCount} mentions)`)
              .join('\n');

            // Format edges
            const edgeList = subgraph.edges
              .map(e => {
                const source = subgraph.nodes.find(n => n.id === e.sourceId);
                const target = subgraph.nodes.find(n => n.id === e.targetId);
                return `  - ${source?.name ?? '?'} --[${e.type}]--> ${target?.name ?? '?'}: ${e.description}`;
              })
              .join('\n');

            const text = [
              `Knowledge Graph for "${entity}"`,
              '',
              `Entities (${subgraph.nodes.length}):`,
              nodeList,
              '',
              `Relationships (${subgraph.edges.length}):`,
              edgeList,
            ].join('\n');

            return {
              content: [{ type: 'text' as const, text }],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_graph' },
    );

    // ====================================================================
    // Tool: ke_stats
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_stats',
        label: 'Knowledge Engine: Statistics',
        description:
          'Get statistics about the knowledge base: total reels, entities, ' +
          'relationships, facts, topics, breakdown by content category and status.',
        parameters: Type.Object({}),
        async execute() {
          const db = openDB(dbPath);

          try {
            const stats: KnowledgeStats = db.getStats();

            const categoryLines = Object.entries(stats.reelsByCategory)
              .map(([cat, count]) => `  ${cat}: ${count}`)
              .join('\n');

            const statusLines = Object.entries(stats.reelsByStatus)
              .map(([status, count]) => `  ${status}: ${count}`)
              .join('\n');

            const text = [
              'Knowledge Base Statistics',
              '',
              `Total Reels: ${stats.totalReels}`,
              `Total Entities: ${stats.totalEntities}`,
              `Total Relationships: ${stats.totalRelationships}`,
              `Total Facts: ${stats.totalFacts}`,
              `Total Topics: ${stats.totalTopics}`,
              `Last Ingested: ${stats.lastIngested ?? '(none)'}`,
              '',
              categoryLines ? `By Category:\n${categoryLines}` : 'By Category: (none)',
              '',
              statusLines ? `By Status:\n${statusLines}` : 'By Status: (none)',
            ].join('\n');

            return {
              content: [{ type: 'text' as const, text }],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_stats' },
    );

    // ====================================================================
    // Tool: ke_recommend
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_recommend',
        label: 'Knowledge Engine: Project Recommendations',
        description:
          'Get project-mode recommendations based on a project description. ' +
          'Searches the knowledge base for relevant repos, tools, techniques, ' +
          'workflows, and architectures. Prioritizes grounded (not hyped) and ' +
          'production-ready results. Each recommendation includes provenance ' +
          '(which reel mentioned it).',
        parameters: Type.Object({
          description: Type.String({
            description: 'Project description to get recommendations for',
          }),
          maxPerCategory: Type.Optional(
            Type.Number({ description: 'Max recommendations per category (default: 5)' }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            description: desc,
            maxPerCategory = 5,
          } = params as { description: string; maxPerCategory?: number };
          const db = openDB(dbPath);

          try {
            const rec = getProjectRecommendations(db, desc, {
              maxPerCategory,
              preferGrounded: true,
              preferProduction: true,
              minMentions: 1,
            });

            const parts: string[] = [];
            parts.push(`Project Recommendations for: "${desc}"`);
            parts.push(`Total matches: ${rec.totalMatches}`);
            parts.push('');

            const sections: Array<[string, typeof rec.repos]> = [
              ['Repositories', rec.repos],
              ['Tools & Libraries', rec.tools],
              ['Techniques', rec.techniques],
              ['Workflows', rec.workflows],
              ['Architectures', rec.architectures],
            ];

            for (const [title, items] of sections) {
              if (items.length === 0) continue;
              parts.push(`${title}:`);
              for (const item of items) {
                const provenance = item.provenanceReels.map(r => r.shortcode).join(', ');
                parts.push(
                  `  - ${item.name} (${item.type}) [score: ${item.score.toFixed(3)}, ` +
                  `hype: ${item.hypeLevel}, readiness: ${item.readiness}, ` +
                  `mentions: ${item.mentionCount}]`,
                );
                if (item.description) {
                  parts.push(`    ${item.description.slice(0, 150)}`);
                }
                if (provenance) {
                  parts.push(`    Source reels: ${provenance}`);
                }
              }
              parts.push('');
            }

            return {
              content: [{ type: 'text' as const, text: parts.join('\n') }],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_recommend' },
    );

    // ====================================================================
    // Tool: ke_digest
    // ====================================================================

    api.registerTool(
      {
        name: 'ke_digest',
        label: 'Knowledge Engine: Digest',
        description:
          'Generate a digest of knowledge base activity over a given period. ' +
          'Shows top topics, trending entities, new discoveries, and top reels. ' +
          'Default period is 7 days.',
        parameters: Type.Object({
          days: Type.Optional(
            Type.Number({ description: 'Number of days to look back (default: 7)' }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { days = 7 } = params as { days?: number };
          const db = openDB(dbPath);

          try {
            const digest = generateDigest(db, days);

            const parts: string[] = [];
            parts.push(`Knowledge Digest: ${digest.period}`);
            parts.push(`Total Reels: ${digest.totalReels}`);
            parts.push(`Period: ${digest.startDate.slice(0, 10)} to ${digest.endDate.slice(0, 10)}`);
            parts.push('');
            parts.push(digest.summary);
            parts.push('');

            if (Object.keys(digest.byCategory).length > 0) {
              parts.push('By Category:');
              for (const [cat, count] of Object.entries(digest.byCategory)) {
                parts.push(`  ${cat}: ${count}`);
              }
              parts.push('');
            }

            if (digest.topTopics.length > 0) {
              parts.push('Top Topics:');
              for (const topic of digest.topTopics) {
                parts.push(`  ${topic.topic} (${topic.reelCount} reels)`);
              }
              parts.push('');
            }

            if (digest.trendingEntities.length > 0) {
              parts.push('Trending Entities:');
              for (const entity of digest.trendingEntities) {
                const badge = entity.isNew ? ' [NEW]' : '';
                parts.push(`  ${entity.name} (${entity.type}, ${entity.mentionCount} mentions)${badge}`);
              }
              parts.push('');
            }

            if (digest.newEntities.length > 0) {
              parts.push('New Entities:');
              for (const entity of digest.newEntities) {
                parts.push(`  + ${entity.name} (${entity.type})`);
              }
              parts.push('');
            }

            if (digest.topReels.length > 0) {
              parts.push('Top Reels:');
              for (const reel of digest.topReels.slice(0, 5)) {
                parts.push(`  [${reel.shortcode}] ${reel.contentType} | @${reel.author}`);
                parts.push(`    ${reel.summary.slice(0, 150)}`);
                parts.push(`    ${reel.url}`);
              }
            }

            return {
              content: [{ type: 'text' as const, text: parts.join('\n') }],
            };
          } finally {
            db.close();
          }
        },
      } as AnyAgentTool,
      { name: 'ke_digest' },
    );

    // ====================================================================
    // CLI Commands: openclaw ke {ingest,search,stats,scan}
    // ====================================================================

    api.registerCli(
      ({ program }) => {
        const ke = program
          .command('ke')
          .description('Knowledge Engine plugin commands');

        ke.command('ingest')
          .description('Ingest content from any URL (Instagram, YouTube, GitHub, Reddit, arXiv, etc.)')
          .argument('<url>', 'URL to ingest')
          .action(async (...args: unknown[]) => {
            const url = args[0] as string;
            const db = openDB(dbPath);
            try {
              if (db.reelExists(url)) {
                console.log('Content already exists in database.');
                return;
              }

              const { sourceType, identifier } = classifyUrl(url);
              console.log(`Ingesting ${sourceType}: ${url}`);

              const result = await ingestContent(url, sourceType, identifier, pipelineConfig);
              const reelId = storeUnifiedResult(db, result);

              console.log(`Done. ID: ${reelId}`);
              console.log(`  Source: ${sourceType}`);
              console.log(`  Type: ${result.knowledge.contentType}`);
              console.log(`  Entities: ${result.knowledge.entities.length}`);
              console.log(`  Facts: ${result.knowledge.facts.length}`);
              console.log(`  Topics: ${result.knowledge.topics.join(', ')}`);
            } finally {
              db.close();
            }
          });

        ke.command('search')
          .description('Search the knowledge base')
          .argument('<query>', 'Search query')
          .option('--limit <n>', 'Max results', '10')
          .action(async (...args: unknown[]) => {
            const query = args[0] as string;
            const opts = (args[1] ?? { limit: '10' }) as { limit: string };
            const db = openDB(dbPath);
            try {
              const results = db.searchReelsFTS(query, parseInt(opts.limit, 10));
              if (results.length === 0) {
                console.log('No results found.');
                return;
              }
              console.log(`Found ${results.length} result(s):\n`);
              for (const r of results) {
                console.log(`  [${r.shortcode}] ${r.content_type} | @${r.author_id}`);
                console.log(`    ${r.summary.slice(0, 120)}`);
                console.log(`    ${r.url}\n`);
              }
            } finally {
              db.close();
            }
          });

        ke.command('stats')
          .description('Show knowledge base statistics')
          .action(() => {
            const db = openDB(dbPath);
            try {
              const stats = db.getStats();
              console.log(JSON.stringify(stats, null, 2));
            } finally {
              db.close();
            }
          });

        ke.command('scan')
          .description('Scan inbox folder for new reel URLs and process them')
          .action(async () => {
            console.log(`Scanning inbox: ${inboxDir}`);
            const db = openDB(dbPath);
            try {
              await startInboxWatcher({
                inboxDir,
                processedDir: path.join(path.dirname(inboxDir), 'processed-inbox'),
                async onUrl(url, sourceFile) {
                  console.log(`[${sourceFile}] Processing: ${url}`);
                  if (db.reelExists(url)) {
                    console.log(`  Already exists, skipping.`);
                    return;
                  }
                  const result = await extractFromReel(url, pipelineConfig);
                  const reelId = storeExtractionResult(db, result);
                  console.log(`  Done: ${reelId} (${result.knowledge.contentType})`);
                },
                logger: {
                  info: (msg) => console.log(msg),
                  warn: (msg) => console.warn(msg),
                  error: (msg) => console.error(msg),
                },
              });

              // Wait briefly then stop (scan mode, not daemon)
              stopInboxWatcher();
              console.log('Scan complete.');
            } finally {
              db.close();
            }
          });
      },
      { commands: ['ke'] },
    );

    // ====================================================================
    // Hook: message_received -- auto-detect any content URLs
    // ====================================================================

    api.on('message_received', async (event) => {
      const ev = event as {
        content?: string;
        reply?: (text: string) => Promise<void>;
        handled?: boolean;
      };
      if (!ev.content) return;

      const detected = detectContentUrls(ev.content);
      if (detected.length === 0) return;

      // Mark as handled so the default chat agent doesn't also reply
      ev.handled = true;

      api.logger.info(
        `knowledge-engine: detected ${detected.length} content URL(s) in message`,
      );

      for (const item of detected) {
        try {
          // Check for duplicate first
          const db = openDB(dbPath);
          try {
            if (db.reelExists(item.url)) {
              api.logger.info(`knowledge-engine: ${item.url} already ingested, skipping`);
              if (ev.reply) {
                await ev.reply(`Already ingested: ${item.url}`);
              }
              continue;
            }
          } finally {
            db.close();
          }

          // Process via unified pipeline
          api.logger.info(`knowledge-engine: ingesting ${item.sourceType}: ${item.url}`);

          if (ev.reply) {
            await ev.reply(`Ingesting ${item.sourceType}... This may take a minute.`);
          }

          const result = await ingestContent(
            item.url, item.sourceType, item.identifier, pipelineConfig,
            item.sourceType === 'plain_text' ? ev.content : undefined,
          );

          const db2 = openDB(dbPath);
          try {
            storeUnifiedResult(db2, result);
          } finally {
            db2.close();
          }

          const entityNames = result.knowledge.entities
            .slice(0, 5)
            .map(e => e.name)
            .join(', ');

          const sourceLabel: Record<string, string> = {
            instagram_reel: 'Instagram Reel',
            youtube: 'YouTube Video',
            github_repo: 'GitHub Repo',
            github_issue: 'GitHub Issue',
            github_pr: 'GitHub PR',
            reddit_post: 'Reddit Post',
            twitter_post: 'Twitter/X Post',
            tiktok: 'TikTok',
            hacker_news: 'Hacker News',
            arxiv_paper: 'arXiv Paper',
            article: 'Article',
            plain_text: 'Note',
          };

          const replyText = [
            `Ingested ${sourceLabel[item.sourceType] || item.sourceType}`,
            `Type: ${result.knowledge.contentType}`,
            `Summary: ${result.knowledge.summary}`,
            entityNames ? `Entities: ${entityNames}` : '',
            `Topics: ${result.knowledge.topics.join(', ')}`,
          ].filter(Boolean).join('\n');

          if (ev.reply) {
            await ev.reply(replyText);
          }

          api.logger.info(
            `knowledge-engine: ingested ${item.url} (${item.sourceType} -> ${result.knowledge.contentType})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.error(
            `knowledge-engine: failed to ingest ${item.url}: ${msg}`,
          );
          if (ev.reply) {
            await ev.reply(`Failed to ingest ${item.sourceType}: ${msg}`);
          }
          // Queue for retry
          try {
            await queueContentForProcessing(item.url, item.sourceType, inboxDir, 'hook');
          } catch { /* ignore queue failure */ }
        }
      }
    });

    // ====================================================================
    // Service: inbox-watcher (background file watcher)
    // ====================================================================

    api.registerService({
      id: 'knowledge-engine-watcher',
      async start() {
        const db = openDB(dbPath);

        await startInboxWatcher({
          inboxDir,
          processedDir: path.join(path.dirname(inboxDir), 'processed-inbox'),
          async onUrl(url, sourceFile) {
            api.logger.info(
              `knowledge-engine: [${sourceFile}] ingesting ${url}`,
            );
            try {
              if (db.reelExists(url)) {
                api.logger.info(
                  `knowledge-engine: ${url} already exists, skipping`,
                );
                return;
              }
              const result = await extractFromReel(url, pipelineConfig);
              storeExtractionResult(db, result);
              api.logger.info(
                `knowledge-engine: ingested ${url} (${result.knowledge.contentType})`,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              api.logger.error(
                `knowledge-engine: ingestion failed for ${url}: ${msg}`,
              );
            }
          },
          logger: {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
            error: (msg) => api.logger.error(msg),
          },
        });

        api.logger.info('knowledge-engine: inbox watcher started');
      },
      stop() {
        stopInboxWatcher();
        api.logger.info('knowledge-engine: inbox watcher stopped');
      },
    });
  },
};

export default knowledgeEnginePlugin;
