import { readFile } from 'fs/promises';
import path from 'path';
import { KnowledgeDB } from '../storage/db.js';
import { storeExtractionResult, storeUnifiedResult } from '../storage/store.js';
import { extractFromReel } from '../extraction/pipeline.js';
import { ingestContent } from '../extraction/unified-pipeline.js';
import { classifyUrl } from '../ingestion/url-router.js';
import { queryKnowledge } from '../query/engine.js';
import { formatResults, formatEntityDetail, formatEntityGraph, formatRecommendation, formatDigest } from '../query/formatter.js';
import { getEntityGraph } from '../graph/query.js';
import { getTrendingEntities } from '../graph/query.js';
import { getEntityNeighbors } from '../graph/builder.js';
import { startInboxWatcher, stopInboxWatcher } from '../ingestion/watcher.js';
import { checkClipboard, startClipboardMonitor, stopClipboardMonitor } from '../ingestion/clipboard-handler.js';
import { queueContentForProcessing } from '../hooks/auto-capture.js';
import { InstagramScraper } from '../ingestion/playwright-scraper.js';
import { getProjectRecommendations } from '../tools/recommend.js';
import { generateDigest } from '../tools/digest.js';
import { enrichAllGitHubEntities } from '../graph/enricher.js';
import { startDashboardServer } from '../dashboard/server.js';
import type { PipelineConfig, KnowledgeStats, StoredReel } from '../types.js';

// ── ANSI color helpers ──────────────────────────────────────────────────

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
function red(s: string): string { return `${C.red}${s}${C.reset}`; }
function dim(s: string): string { return `${C.dim}${s}${C.reset}`; }

// ── Paths ───────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'knowledge.sqlite');
const MEDIA_DIR = path.join(DATA_DIR, 'processed');

// ── Helpers ─────────────────────────────────────────────────────────────

function getDB(): KnowledgeDB {
  const db = new KnowledgeDB(DB_PATH);
  db.init();
  return db;
}

function getPipelineConfig(): PipelineConfig {
  return {
    mediaDir: MEDIA_DIR,
    // KE_WHISPER_MODEL is the documented name (see .env.example);
    // WHISPER_MODEL stays as a fallback for older configs.
    whisperModel: process.env.KE_WHISPER_MODEL || process.env.WHISPER_MODEL || 'base',
    maxOcrFrames: Number(process.env.KE_MAX_OCR_FRAMES) || 5,
  };
}

// ── Commands ────────────────────────────────────────────────────────────

async function cmdIngest(url: string): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: Ingest ===\n'));

  const { sourceType, identifier } = classifyUrl(url);
  console.log(`URL: ${cyan(url)}`);
  console.log(`Source: ${bold(sourceType)} | ID: ${dim(identifier)}\n`);

  const db = getDB();

  try {
    // Check for duplicate
    if (db.reelExists(url)) {
      console.log(yellow('Content already exists in database. Skipping.\n'));
      return;
    }

    console.log(dim('Starting extraction pipeline...\n'));
    const config = getPipelineConfig();
    const result = await ingestContent(url, sourceType, identifier, config);

    console.log(dim('\nStoring results...\n'));
    const reelId = storeUnifiedResult(db, result);

    // Print summary
    console.log(green('\n--- Extraction Complete ---\n'));
    console.log(`  ${bold('ID:')}          ${reelId}`);
    console.log(`  ${bold('Source:')}      ${sourceType}`);
    console.log(`  ${bold('Type:')}        ${result.knowledge.contentType}`);
    console.log(`  ${bold('Sentiment:')}   ${result.knowledge.sentiment}`);
    console.log(`  ${bold('Hype:')}        ${result.knowledge.hypeLevel}`);
    console.log(`  ${bold('Readiness:')}   ${result.knowledge.implementationReadiness}`);
    console.log(`  ${bold('Entities:')}    ${result.knowledge.entities.length}`);
    console.log(`  ${bold('Facts:')}       ${result.knowledge.facts.length}`);
    console.log(`  ${bold('Topics:')}      ${result.knowledge.topics.join(', ')}`);
    console.log(`  ${bold('Tags:')}        ${result.knowledge.tags.join(', ')}`);
    console.log(`  ${bold('Time:')}        ${(result.processingTimeMs / 1000).toFixed(1)}s`);

    if (result.knowledge.summary) {
      console.log(`\n  ${bold('Summary:')}`);
      console.log(`  ${result.knowledge.summary}`);
    }

    if (result.knowledge.githubUrls.length > 0) {
      console.log(`\n  ${bold('GitHub URLs:')}`);
      for (const u of result.knowledge.githubUrls) {
        console.log(`    ${blue(u)}`);
      }
    }

    if (result.knowledge.actionItems.length > 0) {
      console.log(`\n  ${bold('Action Items:')}`);
      for (const item of result.knowledge.actionItems) {
        console.log(`    - ${item}`);
      }
    }

    console.log('');
  } finally {
    db.close();
  }
}

async function cmdBatch(filePath: string): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: Batch Ingest ===\n'));

  const absPath = path.resolve(filePath);
  const content = await readFile(absPath, 'utf-8');
  const urls = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  console.log(`Found ${bold(String(urls.length))} URLs in ${dim(absPath)}\n`);

  const db = getDB();
  const config = getPipelineConfig();
  let success = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(bold(`\n[${i + 1}/${urls.length}] ${url}`));

      if (db.reelExists(url)) {
        console.log(yellow('  Already exists -- skipping'));
        skipped++;
        continue;
      }

      try {
        const { sourceType: st, identifier: ident } = classifyUrl(url);
        const result = await ingestContent(url, st, ident, config);
        storeUnifiedResult(db, result);
        console.log(green(`  Done -- ${st} -> ${result.knowledge.contentType}, ${result.knowledge.entities.length} entities`));
        success++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(red(`  FAILED: ${msg}`));
        failed++;
      }
    }

    console.log(bold('\n--- Batch Complete ---'));
    console.log(`  ${green(`Success: ${success}`)}  ${yellow(`Skipped: ${skipped}`)}  ${red(`Failed: ${failed}`)}`);
    console.log('');
  } finally {
    db.close();
  }
}

function cmdStats(): void {
  console.log(bold('\n=== Knowledge Engine: Statistics ===\n'));

  const db = getDB();
  try {
    const stats: KnowledgeStats = db.getStats();

    console.log(`  ${bold('Total Reels:')}          ${stats.totalReels}`);
    console.log(`  ${bold('Total Entities:')}        ${stats.totalEntities}`);
    console.log(`  ${bold('Total Relationships:')}   ${stats.totalRelationships}`);
    console.log(`  ${bold('Total Facts:')}           ${stats.totalFacts}`);
    console.log(`  ${bold('Total Topics:')}          ${stats.totalTopics}`);
    console.log(`  ${bold('Last Ingested:')}         ${stats.lastIngested || dim('(none)')}`);

    if (Object.keys(stats.reelsByCategory).length > 0) {
      console.log(`\n  ${bold('By Category:')}`);
      for (const [cat, count] of Object.entries(stats.reelsByCategory)) {
        console.log(`    ${cat.padEnd(25)} ${count}`);
      }
    }

    if (Object.keys(stats.reelsByStatus).length > 0) {
      console.log(`\n  ${bold('By Status:')}`);
      for (const [status, count] of Object.entries(stats.reelsByStatus)) {
        console.log(`    ${status.padEnd(25)} ${count}`);
      }
    }

    console.log('');
  } finally {
    db.close();
  }
}

function cmdRecent(limit: number): void {
  console.log(bold(`\n=== Knowledge Engine: Recent Reels (${limit}) ===\n`));

  const db = getDB();
  try {
    const reels: StoredReel[] = db.getRecentReels(limit);

    if (reels.length === 0) {
      console.log(dim('  No reels ingested yet.\n'));
      return;
    }

    for (const reel of reels) {
      console.log(`  ${cyan(reel.shortcode)} ${dim('|')} ${reel.content_type.padEnd(22)} ${dim('|')} @${reel.author_id}`);
      console.log(`    ${reel.summary.slice(0, 100)}${reel.summary.length > 100 ? '...' : ''}`);
      console.log(`    ${dim(reel.created_at)}`);
      console.log('');
    }
  } finally {
    db.close();
  }
}

function cmdSearch(query: string): void {
  const db = getDB();
  try {
    const results = queryKnowledge(db, query, {
      limit: 20,
      includeEntities: true,
      includeFacts: true,
    });

    console.log(formatResults(results, {
      showScores: true,
      showEntities: true,
      showFacts: true,
      db,
    }));
  } finally {
    db.close();
  }
}

function cmdEntity(name: string): void {
  const db = getDB();
  try {
    const entity = db.getEntityByName(name);
    if (!entity) {
      console.log(red(`\n  Entity "${name}" not found.\n`));
      return;
    }

    // Get relationships with resolved names
    const neighbors = getEntityNeighbors(db, entity.id);
    const relationships = neighbors.map(n => ({
      type: n.relationship.type,
      targetName: n.entity.name,
      targetType: n.entity.type,
      direction: n.direction,
      evidenceCount: n.relationship.evidenceCount,
    }));

    // Count reels
    const reelCount = (db.raw
      .prepare('SELECT COUNT(*) as c FROM reel_entities WHERE entity_id = ?')
      .get(entity.id) as { c: number }).c;

    console.log(formatEntityDetail(entity, relationships, reelCount));
  } finally {
    db.close();
  }
}

function cmdTopics(): void {
  console.log(bold('\n=== Knowledge Engine: Topics ===\n'));

  const db = getDB();
  try {
    const topics = db.getTopTopics(50);

    if (topics.length === 0) {
      console.log(dim('  No topics found.\n'));
      return;
    }

    for (const topic of topics) {
      console.log(`  ${cyan(topic.name.padEnd(30))} ${dim(`${topic.reel_count} reel(s)`)}`);
      if (topic.description) {
        console.log(`    ${dim(topic.description)}`);
      }
    }
    console.log('');
  } finally {
    db.close();
  }
}

function cmdGraph(entityName: string): void {
  const db = getDB();
  try {
    const subgraph = getEntityGraph(db, entityName);
    if (!subgraph) {
      console.log(red(`\n  Entity "${entityName}" not found.\n`));
      return;
    }

    console.log(formatEntityGraph(subgraph.nodes, subgraph.edges, subgraph.centerEntityId));
  } finally {
    db.close();
  }
}

function cmdTrending(days: number): void {
  console.log(bold(`\n=== Knowledge Engine: Trending (${days} days) ===\n`));

  const db = getDB();
  try {
    const trending = getTrendingEntities(db, days);

    if (trending.length === 0) {
      console.log(dim('  No trending entities found.\n'));
      return;
    }

    for (let i = 0; i < trending.length; i++) {
      const e = trending[i];
      console.log(
        `  ${bold(`${i + 1}.`)} ${cyan(e.name)} ${dim(`[${e.type}]`)} ${dim(`-- ${e.recentMentions} recent, ${e.totalMentions} total`)}`,
      );
    }
    console.log('');
  } finally {
    db.close();
  }
}

// ── Phase 4: Automated Ingestion Commands ────────────────────────────────

const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const PROCESSED_DIR = path.join(DATA_DIR, 'processed-inbox');

async function cmdWatch(): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: Watch Mode ===\n'));
  console.log(dim('  Watching inbox + clipboard. Press Ctrl+C to stop.\n'));

  const db = getDB();
  const config = getPipelineConfig();

  const processUrl = async (url: string, source: string) => {
    console.log(`  [${source}] ${cyan(url)}`);
    if (db.reelExists(url)) {
      console.log(dim('    Already exists -- skipping'));
      return;
    }
    try {
      const { sourceType: st, identifier: ident } = classifyUrl(url);
      const result = await ingestContent(url, st, ident, config);
      const reelId = storeUnifiedResult(db, result);
      console.log(green(`    Ingested: ${reelId} (${st} -> ${result.knowledge.contentType})`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`    Failed: ${msg}`));
    }
  };

  // Start inbox watcher
  await startInboxWatcher({
    inboxDir: INBOX_DIR,
    processedDir: PROCESSED_DIR,
    async onUrl(url, sourceFile) {
      await processUrl(url, `file:${sourceFile}`);
    },
    logger: {
      info: (msg) => console.log(dim(msg)),
      warn: (msg) => console.warn(yellow(msg)),
      error: (msg) => console.error(red(msg)),
    },
  });

  // Start clipboard monitor (check every 2 seconds)
  const clipTimer = startClipboardMonitor(2000, async (url) => {
    await processUrl(url, 'clipboard');
  });

  console.log(green('  Inbox watcher started'));
  console.log(green('  Clipboard monitor started (2s interval)'));
  console.log('');

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      console.log(dim('\n  Shutting down...'));
      stopClipboardMonitor(clipTimer);
      stopInboxWatcher();
      db.close();
      resolve();
    });
  });
}

async function cmdClipboard(): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: Clipboard Check ===\n'));

  const url = await checkClipboard();
  if (!url) {
    console.log(dim('  No Instagram reel URL found in clipboard.\n'));
    return;
  }

  console.log(`  Found: ${cyan(url)}`);
  const { sourceType: clipSt } = classifyUrl(url);
  await queueContentForProcessing(url, clipSt, INBOX_DIR, 'clipboard');
  console.log(green('  Queued for processing.\n'));
}

async function cmdScrape(): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: Instagram Scraper ===\n'));
  console.log(dim('  NOTE: This is experimental and may not work reliably.\n'));

  const cookiePath = path.join(DATA_DIR, 'instagram-state.json');
  const scraper = new InstagramScraper({ cookiePath });

  try {
    await scraper.init();
    console.log(dim('  Browser launched. Scraping self-chat...'));

    const result = await scraper.scrapeReelLinks(10);

    if (result.hadErrors) {
      console.log(red(`  Error: ${result.errorMessage}`));
    }

    console.log(`  Found ${bold(String(result.urls.length))} reel URLs`);
    for (const url of result.urls) {
      console.log(`    ${cyan(url)}`);
      await queueContentForProcessing(url, 'instagram_reel', INBOX_DIR, 'scraper');
    }

    if (result.urls.length > 0) {
      console.log(green(`\n  Queued ${result.urls.length} URLs for processing.`));
    }
  } finally {
    await scraper.close();
  }
  console.log('');
}

// ── Phase 5: Recommendation, Digest, Enrichment Commands ────────────────

function cmdRecommend(description: string): void {
  console.log(bold('\n=== Knowledge Engine: Project Recommendations ===\n'));

  const db = getDB();
  try {
    const rec = getProjectRecommendations(db, description, {
      maxPerCategory: 5,
      preferGrounded: true,
      preferProduction: true,
      minMentions: 1,
    });

    console.log(formatRecommendation(rec));
  } finally {
    db.close();
  }
}

function cmdDigest(days: number): void {
  console.log(bold(`\n=== Knowledge Engine: Digest (${days} days) ===\n`));

  const db = getDB();
  try {
    const digest = generateDigest(db, days);
    console.log(formatDigest(digest));
  } finally {
    db.close();
  }
}

async function cmdEnrich(): Promise<void> {
  console.log(bold('\n=== Knowledge Engine: GitHub Enrichment ===\n'));

  const db = getDB();
  try {
    const count = await enrichAllGitHubEntities(db, {
      logger: {
        info: (msg) => console.log(dim(msg)),
        warn: (msg) => console.warn(yellow(msg)),
      },
    });

    console.log(green(`\n  Enriched ${count} repository entities.\n`));
  } finally {
    db.close();
  }
}

// ── Phase 6: Dashboard Command ───────────────────────────────────────────

function cmdDashboard(port: number, external?: boolean): void {
  startDashboardServer({ port, external });
}

// ── Usage ───────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
${bold('Knowledge Engine')} - Extract knowledge from any content

${bold('Usage:')}
  ke ingest <url>            Ingest any URL (IG, YT, GitHub, Reddit, arXiv, etc.)
  ke batch <file>            Process URLs from file (one per line)
  ke stats                   Show knowledge base statistics
  ke recent [n]              Show n most recent reels (default: 10)
  ke search <query>          Multi-signal search (FTS + vector + graph)
  ke entity <name>           Show entity details + relationships
  ke topics                  List all topics with reel counts
  ke graph <entity>          Show entity relationship graph
  ke trending [days]         Trending entities (default: 7 days)
  ke watch                   Start inbox watcher + clipboard monitor
  ke clipboard               Single clipboard check for reel URLs
  ke scrape                  Run Playwright scraper (one-shot, experimental)
  ke recommend <description> Project mode recommendations
  ke digest [days]           Weekly/custom period digest
  ke enrich                  Run GitHub enrichment on all repos
  ke dashboard [--port 3737] [--external] Start the web dashboard

${bold('Environment:')}
  KE_WHISPER_MODEL           Whisper model size: base, small, medium (default: base)
  KE_DB_PATH                 SQLite database path (default: data/knowledge.sqlite)
  KE_DASHBOARD_PORT          Dashboard port (default: 3737)
  KE_DASHBOARD_EXTERNAL      Set true to enable authenticated external mode
  KE_DASHBOARD_HOST          Bind host (default: 127.0.0.1, or 0.0.0.0 in external mode)
  KE_DASHBOARD_TOKEN         External-mode token (required, at least 32 bytes)
  KE_DASHBOARD_ALLOWED_ORIGINS Comma-separated exact browser origins
  KE_MAX_OCR_FRAMES          Frames to OCR per video (default: 5)

${bold('Supported sources:')}
  Instagram reels, YouTube, TikTok, GitHub repos/issues/PRs,
  Reddit posts, Hacker News, arXiv papers, Twitter/X, any article URL

${bold('Examples:')}
  ke ingest https://github.com/vercel/next.js
  ke ingest https://www.youtube.com/watch?v=dQw4w9WgXcQ
  ke ingest https://www.instagram.com/reel/ABC123/
  ke ingest https://arxiv.org/abs/2301.00001
  ke batch urls.txt
  ke search "transformer attention"
  ke entity react
  ke graph pytorch
  ke trending 30
  ke recommend "building a real-time ML pipeline"
  ke digest 14
`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'ingest': {
      const url = args[1];
      if (!url) {
        console.error(red('Error: URL required. Usage: ke ingest <url>'));
        process.exit(1);
      }
      await cmdIngest(url);
      break;
    }

    case 'batch': {
      const file = args[1];
      if (!file) {
        console.error(red('Error: File path required. Usage: ke batch <file>'));
        process.exit(1);
      }
      await cmdBatch(file);
      break;
    }

    case 'stats':
      cmdStats();
      break;

    case 'recent': {
      const limit = args[1] ? parseInt(args[1], 10) : 10;
      cmdRecent(limit);
      break;
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.error(red('Error: Query required. Usage: ke search <query>'));
        process.exit(1);
      }
      cmdSearch(query);
      break;
    }

    case 'entity': {
      const entityName = args.slice(1).join(' ');
      if (!entityName) {
        console.error(red('Error: Entity name required. Usage: ke entity <name>'));
        process.exit(1);
      }
      cmdEntity(entityName);
      break;
    }

    case 'topics':
      cmdTopics();
      break;

    case 'graph': {
      const graphEntity = args.slice(1).join(' ');
      if (!graphEntity) {
        console.error(red('Error: Entity name required. Usage: ke graph <entity>'));
        process.exit(1);
      }
      cmdGraph(graphEntity);
      break;
    }

    case 'trending': {
      const trendDays = args[1] ? parseInt(args[1], 10) : 7;
      cmdTrending(trendDays);
      break;
    }

    case 'watch':
      await cmdWatch();
      break;

    case 'clipboard':
      await cmdClipboard();
      break;

    case 'scrape':
      await cmdScrape();
      break;

    case 'recommend': {
      const desc = args.slice(1).join(' ');
      if (!desc) {
        console.error(red('Error: Project description required. Usage: ke recommend <description>'));
        process.exit(1);
      }
      cmdRecommend(desc);
      break;
    }

    case 'digest': {
      const digestDays = args[1] ? parseInt(args[1], 10) : 7;
      cmdDigest(digestDays);
      break;
    }

    case 'enrich':
      await cmdEnrich();
      break;

    case 'dashboard': {
      let dashPort = 3737;
      const portIdx = args.indexOf('--port');
      if (portIdx !== -1 && args[portIdx + 1]) {
        dashPort = parseInt(args[portIdx + 1], 10);
      }
      const external = args.includes('--external') ? true : undefined;
      cmdDashboard(dashPort, external);
      // Keep alive -- server handles its own lifecycle
      await new Promise<void>(() => {});
      break;
    }

    default:
      printUsage();
      break;
  }
}

main().catch(err => {
  console.error(red(`\nFatal error: ${err.message}`));
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
