import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeDB } from '../storage/db.js';
import { getEntityGraph } from '../graph/query.js';
import { getTrendingEntities } from '../graph/query.js';
import { getProjectRecommendations } from '../tools/recommend.js';
import { generateDigest } from '../tools/digest.js';
import { queryKnowledge } from '../query/engine.js';
import type { GraphNode, GraphEdge } from '../graph/builder.js';

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_PORT = 3737;
const PORT = parseInt(process.env.KE_DASHBOARD_PORT || String(DEFAULT_PORT), 10);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = process.env.KE_DB_PATH || path.join(DATA_DIR, 'knowledge.sqlite');
const HTML_PATH = path.join(import.meta.dirname, 'index.html');

// ── Database ────────────────────────────────────────────────────────────

let db: KnowledgeDB;

function getDB(): KnowledgeDB {
  if (!db) {
    db = new KnowledgeDB(DB_PATH);
    db.init();
  }
  return db;
}

// ── SSE Clients ─────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

export function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Response Helpers ────────────────────────────────────────────────────

function sendJSON(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, message: string, status = 500): void {
  sendJSON(res, { error: message }, status);
}

function sendHTML(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// ── Route Handlers ──────────────────────────────────────────────────────

function handleStats(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const database = getDB();
  const stats = database.getStats();
  sendJSON(res, stats);
}

function handleReels(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const reels = database.raw.prepare(`
    SELECT * FROM reels ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = (database.raw.prepare('SELECT COUNT(*) as c FROM reels').get() as { c: number }).c;

  sendJSON(res, { reels, total, limit, offset });
}

function handleReelDetail(id: string, res: http.ServerResponse): void {
  const database = getDB();
  const reel = database.getReelById(id);

  if (!reel) {
    sendError(res, 'Reel not found', 404);
    return;
  }

  const entities = database.getEntitiesForReel(id);
  const facts = database.getFactsForReel(id);

  const tags = database.raw.prepare(
    'SELECT tag FROM reel_tags WHERE reel_id = ?',
  ).all(id) as Array<{ tag: string }>;

  sendJSON(res, { reel, entities, facts, tags: tags.map(t => t.tag) });
}

function handleEntities(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const typeFilter = url.searchParams.get('type') || '';
  const q = url.searchParams.get('q') || '';

  let entities;
  if (q) {
    entities = database.searchEntities(q, limit);
    if (typeFilter) {
      entities = entities.filter(e => e.type === typeFilter);
    }
  } else if (typeFilter) {
    entities = database.getEntitiesByType(typeFilter, limit);
  } else {
    entities = database.raw.prepare(
      'SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?',
    ).all(limit);
  }

  sendJSON(res, { entities });
}

function handleEntityDetail(name: string, res: http.ServerResponse): void {
  const database = getDB();
  const entity = database.getEntityByName(name);

  if (!entity) {
    sendError(res, 'Entity not found', 404);
    return;
  }

  const relationships = database.getRelationshipsForEntity(entity.id);

  // Resolve relationship entity names
  const resolvedRelationships = relationships.map(rel => {
    const sourceEntity = database.raw.prepare(
      'SELECT display_name, canonical_name, type FROM entities WHERE id = ?',
    ).get(rel.source_entity_id) as { display_name: string; canonical_name: string; type: string } | undefined;
    const targetEntity = database.raw.prepare(
      'SELECT display_name, canonical_name, type FROM entities WHERE id = ?',
    ).get(rel.target_entity_id) as { display_name: string; canonical_name: string; type: string } | undefined;

    return {
      ...rel,
      source_name: sourceEntity?.display_name || sourceEntity?.canonical_name || 'unknown',
      source_type: sourceEntity?.type || 'unknown',
      target_name: targetEntity?.display_name || targetEntity?.canonical_name || 'unknown',
      target_type: targetEntity?.type || 'unknown',
    };
  });

  // Get source reels
  const sourceReels = database.raw.prepare(`
    SELECT r.id, r.shortcode, r.summary, r.content_type, r.author, r.created_at
    FROM reel_entities re
    JOIN reels r ON r.id = re.reel_id
    WHERE re.entity_id = ?
    ORDER BY r.created_at DESC
    LIMIT 20
  `).all(entity.id);

  sendJSON(res, { entity, relationships: resolvedRelationships, sourceReels });
}

function handleEntityGraph(entityName: string, res: http.ServerResponse): void {
  const database = getDB();
  const subgraph = getEntityGraph(database, entityName);

  if (!subgraph) {
    sendError(res, 'Entity not found', 404);
    return;
  }

  sendJSON(res, subgraph);
}

function handleFullGraph(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  // Get top entities by mention count
  const topEntities = database.raw.prepare(`
    SELECT id, canonical_name, display_name, type, mention_count
    FROM entities
    ORDER BY mention_count DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    canonical_name: string;
    display_name: string;
    type: string;
    mention_count: number;
  }>;

  const entityIds = new Set(topEntities.map(e => e.id));

  const nodes: GraphNode[] = topEntities.map(e => ({
    id: e.id,
    name: e.display_name || e.canonical_name,
    type: e.type,
    mentionCount: e.mention_count,
  }));

  // Get all edges between these entities
  const edges: GraphEdge[] = [];
  if (topEntities.length > 0) {
    const placeholders = topEntities.map(() => '?').join(', ');
    const ids = topEntities.map(e => e.id);

    const relRows = database.raw.prepare(`
      SELECT id, source_entity_id, target_entity_id, type, description, evidence_count
      FROM relationships
      WHERE source_entity_id IN (${placeholders})
        AND target_entity_id IN (${placeholders})
    `).all(...ids, ...ids) as Array<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
      type: string;
      description: string;
      evidence_count: number;
    }>;

    for (const rel of relRows) {
      if (entityIds.has(rel.source_entity_id) && entityIds.has(rel.target_entity_id)) {
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

  sendJSON(res, { nodes, edges });
}

function handleSearch(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const q = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);

  if (!q) {
    sendError(res, 'Query parameter "q" is required', 400);
    return;
  }

  const result = queryKnowledge(database, q, {
    limit,
    includeEntities: true,
    includeFacts: true,
  });

  // Resolve reel details for the ranked results
  const reels = result.reels.map(r => {
    const reel = database.getReelById(r.reelId);
    return { ...r, reel };
  });

  sendJSON(res, { ...result, reels });
}

function handleRecommend(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const project = url.searchParams.get('project') || '';

  if (!project) {
    sendError(res, 'Query parameter "project" is required', 400);
    return;
  }

  const recommendations = getProjectRecommendations(database, project, {
    maxPerCategory: 5,
    preferGrounded: true,
    preferProduction: true,
    minMentions: 1,
  });

  sendJSON(res, recommendations);
}

function handleDigest(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const digest = generateDigest(database, days);
  sendJSON(res, digest);
}

function handleTopics(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const database = getDB();
  const topics = database.getTopTopics(100);
  sendJSON(res, { topics });
}

function handleTrending(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const trending = getTrendingEntities(database, days);
  sendJSON(res, { trending });
}

function handleTimeline(url: URL, res: http.ServerResponse): void {
  const database = getDB();
  const days = parseInt(url.searchParams.get('days') || '30', 10);

  const rows = database.raw.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM reels
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(days) as Array<{ day: string; count: number }>;

  sendJSON(res, { timeline: rows });
}

function handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ── Request Router ──────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(rawUrl, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${method} ${pathname}`);

  try {
    // ── Static routes ─────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(HTML_PATH, 'utf-8');
      sendHTML(res, html);
      return;
    }

    // ── SSE ───────────────────────────────────────────────────────────
    if (pathname === '/events') {
      handleSSE(req, res);
      return;
    }

    // ── API routes ────────────────────────────────────────────────────
    if (pathname === '/api/stats') {
      handleStats(req, res);
      return;
    }

    if (pathname === '/api/reels') {
      handleReels(url, res);
      return;
    }

    // /api/reels/:id
    const reelMatch = pathname.match(/^\/api\/reels\/(.+)$/);
    if (reelMatch) {
      handleReelDetail(decodeURIComponent(reelMatch[1]), res);
      return;
    }

    if (pathname === '/api/entities') {
      handleEntities(url, res);
      return;
    }

    // /api/entity/:name
    const entityMatch = pathname.match(/^\/api\/entity\/(.+)$/);
    if (entityMatch) {
      handleEntityDetail(decodeURIComponent(entityMatch[1]), res);
      return;
    }

    // /api/graph/full
    if (pathname === '/api/graph/full') {
      handleFullGraph(url, res);
      return;
    }

    // /api/graph/:entity
    const graphMatch = pathname.match(/^\/api\/graph\/(.+)$/);
    if (graphMatch) {
      handleEntityGraph(decodeURIComponent(graphMatch[1]), res);
      return;
    }

    if (pathname === '/api/search') {
      handleSearch(url, res);
      return;
    }

    if (pathname === '/api/recommend') {
      handleRecommend(url, res);
      return;
    }

    if (pathname === '/api/digest') {
      handleDigest(url, res);
      return;
    }

    if (pathname === '/api/topics') {
      handleTopics(req, res);
      return;
    }

    if (pathname === '/api/trending') {
      handleTrending(url, res);
      return;
    }

    if (pathname === '/api/timeline') {
      handleTimeline(url, res);
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────
    sendError(res, 'Not found', 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] ${pathname}: ${message}`);
    sendError(res, message, 500);
  }
}

// ── Server Start ────────────────────────────────────────────────────────

export function startDashboardServer(port = PORT): http.Server {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('Unhandled error:', err);
      try {
        sendError(res, 'Internal server error', 500);
      } catch {
        // Response might already be sent
      }
    });
  });

  server.listen(port, () => {
    console.log(`\n  KNOWLEDGE ENGINE DASHBOARD`);
    console.log(`  ========================`);
    console.log(`  Running at: http://localhost:${port}`);
    console.log(`  Database:   ${DB_PATH}`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });

  process.on('SIGINT', () => {
    console.log('\n  Shutting down dashboard...');
    server.close();
    if (db) db.close();
    process.exit(0);
  });

  return server;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dashboard/server.ts')) {
  startDashboardServer();
}
