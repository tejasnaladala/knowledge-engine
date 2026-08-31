import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
const DEFAULT_HOST = '127.0.0.1';
const EXTERNAL_HOST = '0.0.0.0';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'knowledge.sqlite');
const DEFAULT_HTML_PATH = path.join(import.meta.dirname, 'index.html');

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  external?: boolean;
  token?: string;
  allowedOrigins?: string[];
  dbPath?: string;
  htmlPath?: string;
  installSignalHandlers?: boolean;
}

export interface DashboardConfig {
  port: number;
  host: string;
  external: boolean;
  token?: string;
  allowedOrigins: ReadonlySet<string>;
  dbPath: string;
  htmlPath: string;
  installSignalHandlers: boolean;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== origin) {
    throw new Error(`Invalid dashboard origin: ${origin}`);
  }
  return parsed.origin;
}

export function resolveDashboardConfig(
  options: DashboardServerOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): DashboardConfig {
  const external = options.external
    ?? parseBoolean(environment.KE_DASHBOARD_EXTERNAL, 'KE_DASHBOARD_EXTERNAL');
  const host = (options.host ?? environment.KE_DASHBOARD_HOST
    ?? (external ? EXTERNAL_HOST : DEFAULT_HOST)).trim();
  const rawPort = options.port ?? Number(environment.KE_DASHBOARD_PORT ?? DEFAULT_PORT);
  const token = options.token ?? environment.KE_DASHBOARD_TOKEN;
  const rawOrigins = options.allowedOrigins
    ?? (environment.KE_DASHBOARD_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);

  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new Error('Dashboard port must be an integer from 0 to 65535');
  }
  if (!host) throw new Error('Dashboard host cannot be empty');
  if (!external && !isLoopbackHost(host)) {
    throw new Error('Non-loopback dashboard binding requires explicit external mode');
  }
  if (external && (!token || Buffer.byteLength(token, 'utf8') < 32)) {
    throw new Error('External dashboard mode requires KE_DASHBOARD_TOKEN with at least 32 bytes');
  }

  return {
    port: rawPort,
    host,
    external,
    token,
    allowedOrigins: new Set(rawOrigins.map(normalizeOrigin)),
    dbPath: options.dbPath ?? environment.KE_DB_PATH ?? DEFAULT_DB_PATH,
    htmlPath: options.htmlPath ?? DEFAULT_HTML_PATH,
    installSignalHandlers: options.installSignalHandlers ?? true,
  };
}

// ── Database ────────────────────────────────────────────────────────────

type DatabaseProvider = () => KnowledgeDB;

// ── SSE Clients ─────────────────────────────────────────────────────────

const sseClients = new Map<http.ServerResponse, DashboardConfig>();

export function broadcastSSE(event: string, data: unknown): void {
  for (const [client, config] of sseClients) {
    const payloadData = config.external ? minimizeExternalPayload(data) : data;
    const payload = `event: ${event}\ndata: ${JSON.stringify(payloadData)}\n\n`;
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Response Helpers ────────────────────────────────────────────────────

const responseConfigs = new WeakMap<http.ServerResponse, DashboardConfig>();
const EXTERNAL_PRIVATE_FIELDS = new Set([
  'url',
  'metadata',
  'caption',
  'transcript',
  'ocr_text',
  'ocrTexts',
  'thumbnail_url',
  'thumbnailUrl',
  'github_urls',
  'githubUrls',
  'action_items',
  'actionItems',
  'error_message',
  'errorMessage',
  'aliases',
  'upload_date',
  'uploadDate',
  'like_count',
  'likeCount',
  'comment_count',
  'commentCount',
  'duration',
  'updated_at',
]);

const EXTERNAL_REEL_FIELDS = new Set([
  'id',
  'shortcode',
  'source_type',
  'author',
  'author_id',
  'view_count',
  'summary',
  'content_type',
  'sentiment',
  'hype_level',
  'implementation_readiness',
  'created_at',
]);

function isStoredReelPayload(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string'
    && typeof value.shortcode === 'string'
    && ('transcript' in value || 'ocr_text' in value || 'github_urls' in value);
}

export function minimizeExternalPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(minimizeExternalPayload);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  if (isStoredReelPayload(record)) {
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => EXTERNAL_REEL_FIELDS.has(key))
        .map(([key, nestedValue]) => [key, minimizeExternalPayload(nestedValue)]),
    );
  }

  const minimized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    if (!EXTERNAL_PRIVATE_FIELDS.has(key)) {
      minimized[key] = minimizeExternalPayload(nestedValue);
    }
  }
  return minimized;
}

function sendJSON(res: http.ServerResponse, data: unknown, status = 200): void {
  const config = responseConfigs.get(res);
  const responseData = config?.external ? minimizeExternalPayload(data) : data;
  const body = JSON.stringify(responseData);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': config?.external ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, message: string, status = 500): void {
  sendJSON(res, { error: message }, status);
}

function sendHTML(res: http.ServerResponse, html: string): void {
  const config = responseConfigs.get(res);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': config?.external ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

// ── Route Handlers ──────────────────────────────────────────────────────

function handleStats(getDatabase: DatabaseProvider, res: http.ServerResponse): void {
  const database = getDatabase();
  const stats = database.getStats();
  sendJSON(res, stats);
}

function handleReels(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const reels = database.raw.prepare(`
    SELECT * FROM reels ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = (database.raw.prepare('SELECT COUNT(*) as c FROM reels').get() as { c: number }).c;

  sendJSON(res, { reels, total, limit, offset });
}

function handleReelDetail(getDatabase: DatabaseProvider, id: string, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleEntities(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleEntityDetail(getDatabase: DatabaseProvider, name: string, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleEntityGraph(getDatabase: DatabaseProvider, entityName: string, res: http.ServerResponse): void {
  const database = getDatabase();
  const subgraph = getEntityGraph(database, entityName);

  if (!subgraph) {
    sendError(res, 'Entity not found', 404);
    return;
  }

  sendJSON(res, subgraph);
}

function handleFullGraph(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleSearch(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleRecommend(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
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

function handleDigest(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const digest = generateDigest(database, days);
  sendJSON(res, digest);
}

function handleTopics(getDatabase: DatabaseProvider, res: http.ServerResponse): void {
  const database = getDatabase();
  const topics = database.getTopTopics(100);
  sendJSON(res, { topics });
}

function handleTrending(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const trending = getTrendingEntities(database, days);
  sendJSON(res, { trending });
}

function handleTimeline(getDatabase: DatabaseProvider, url: URL, res: http.ServerResponse): void {
  const database = getDatabase();
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
  const config = responseConfigs.get(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': config?.external ? 'no-store' : 'no-cache',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

  if (config) sseClients.set(res, config);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ── Request Router ──────────────────────────────────────────────────────

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAuthorized(req: http.IncomingMessage, config: DashboardConfig): boolean {
  if (!config.external) return true;
  const authorization = req.headers.authorization;
  if (!authorization || !config.token) return false;

  const separator = authorization.indexOf(' ');
  if (separator === -1) return false;
  const scheme = authorization.slice(0, separator).toLowerCase();
  const credentials = authorization.slice(separator + 1).trim();

  if (scheme === 'bearer') return tokensMatch(credentials, config.token);
  if (scheme !== 'basic') return false;

  try {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const delimiter = decoded.indexOf(':');
    return delimiter !== -1
      && decoded.slice(0, delimiter) === 'knowledge-engine'
      && tokensMatch(decoded.slice(delimiter + 1), config.token);
  } catch {
    return false;
  }
}

function appendVaryOrigin(res: http.ServerResponse): void {
  const current = res.getHeader('Vary');
  const values = String(current ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (!values.some(value => value.toLowerCase() === 'origin')) values.push('Origin');
  res.setHeader('Vary', values.join(', '));
}

function isAllowedOrigin(
  origin: string,
  req: http.IncomingMessage,
  config: DashboardConfig,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
  if (config.allowedOrigins.has(origin)) return true;

  const requestHost = req.headers.host?.toLowerCase();
  return Boolean(requestHost && parsed.host.toLowerCase() === requestHost);
}

function applyOriginPolicy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: DashboardConfig,
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedOrigin(origin, req, config)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (config.external) res.setHeader('Access-Control-Allow-Credentials', 'true');
  appendVaryOrigin(res);
  return true;
}

function handlePreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: DashboardConfig,
): void {
  const origin = req.headers.origin;
  const requestedMethod = req.headers['access-control-request-method']?.toUpperCase();
  const requestedHeaders = (req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map(header => header.trim().toLowerCase())
    .filter(Boolean);
  const permittedHeaders = new Map([
    ['authorization', 'Authorization'],
    ['content-type', 'Content-Type'],
  ]);

  if (!origin
    || !isAllowedOrigin(origin, req, config)
    || requestedMethod !== 'GET'
    || requestedHeaders.some(header => !permittedHeaders.has(header))) {
    sendError(res, 'Origin not allowed', 403);
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (config.external) res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (requestedHeaders.length > 0) {
    res.setHeader(
      'Access-Control-Allow-Headers',
      requestedHeaders.map(header => permittedHeaders.get(header)).join(', '),
    );
  }
  appendVaryOrigin(res);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: DashboardConfig,
  getDatabase: DatabaseProvider,
): Promise<void> {
  responseConfigs.set(res, config);
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';

  if (method === 'OPTIONS') {
    handlePreflight(req, res, config);
    return;
  }

  if (!applyOriginPolicy(req, res, config)) {
    sendError(res, 'Origin not allowed', 403);
    return;
  }

  if (!isAuthorized(req, config)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Knowledge Engine", charset="UTF-8"');
    sendError(res, 'Authentication required', 401);
    return;
  }

  const url = new URL(rawUrl, 'http://localhost');
  const pathname = url.pathname;

  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${method} ${pathname}`);

  try {
    // ── Static routes ─────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(config.htmlPath, 'utf-8');
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
      handleStats(getDatabase, res);
      return;
    }

    if (pathname === '/api/reels') {
      handleReels(getDatabase, url, res);
      return;
    }

    // /api/reels/:id
    const reelMatch = pathname.match(/^\/api\/reels\/(.+)$/);
    if (reelMatch) {
      handleReelDetail(getDatabase, decodeURIComponent(reelMatch[1]), res);
      return;
    }

    if (pathname === '/api/entities') {
      handleEntities(getDatabase, url, res);
      return;
    }

    // /api/entity/:name
    const entityMatch = pathname.match(/^\/api\/entity\/(.+)$/);
    if (entityMatch) {
      handleEntityDetail(getDatabase, decodeURIComponent(entityMatch[1]), res);
      return;
    }

    // /api/graph/full
    if (pathname === '/api/graph/full') {
      handleFullGraph(getDatabase, url, res);
      return;
    }

    // /api/graph/:entity
    const graphMatch = pathname.match(/^\/api\/graph\/(.+)$/);
    if (graphMatch) {
      handleEntityGraph(getDatabase, decodeURIComponent(graphMatch[1]), res);
      return;
    }

    if (pathname === '/api/search') {
      handleSearch(getDatabase, url, res);
      return;
    }

    if (pathname === '/api/recommend') {
      handleRecommend(getDatabase, url, res);
      return;
    }

    if (pathname === '/api/digest') {
      handleDigest(getDatabase, url, res);
      return;
    }

    if (pathname === '/api/topics') {
      handleTopics(getDatabase, res);
      return;
    }

    if (pathname === '/api/trending') {
      handleTrending(getDatabase, url, res);
      return;
    }

    if (pathname === '/api/timeline') {
      handleTimeline(getDatabase, url, res);
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────
    sendError(res, 'Not found', 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] ${pathname}: ${message}`);
    sendError(res, config.external ? 'Internal server error' : message, 500);
  }
}

// ── Server Start ────────────────────────────────────────────────────────

export function startDashboardServer(
  options: number | DashboardServerOptions = {},
): http.Server {
  const config = resolveDashboardConfig(
    typeof options === 'number' ? { port: options } : options,
  );
  let database: KnowledgeDB | undefined;
  const getDatabase = (): KnowledgeDB => {
    if (!database) {
      database = new KnowledgeDB(config.dbPath);
      database.init();
    }
    return database;
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, getDatabase).catch(err => {
      console.error('Unhandled error:', err);
      try {
        sendError(res, 'Internal server error', 500);
      } catch {
        // Response might already be sent
      }
    });
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : config.port;
    const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`\n  KNOWLEDGE ENGINE DASHBOARD`);
    console.log(`  ========================`);
    console.log(`  Running at: http://${displayHost}:${actualPort}`);
    console.log(`  Mode:       ${config.external ? 'external (authenticated)' : 'local only'}`);
    console.log(`  Database:   ${config.dbPath}`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });

  const handleSigint = (): void => {
    console.log('\n  Shutting down dashboard...');
    server.close(() => process.exit(0));
  };

  if (config.installSignalHandlers) process.once('SIGINT', handleSigint);

  server.once('close', () => {
    if (config.installSignalHandlers) process.removeListener('SIGINT', handleSigint);
    if (database) {
      database.close();
      database = undefined;
    }
  });

  return server;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dashboard/server.ts')) {
  startDashboardServer();
}
