import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeDB } from '../src/storage/db.js';
import {
  minimizeExternalPayload,
  resolveDashboardConfig,
  startDashboardServer,
  type DashboardServerOptions,
} from '../src/dashboard/server.js';

const TOKEN = 'test-dashboard-token-at-least-32-bytes-long';
const TRUSTED_ORIGIN = 'https://dashboard.example.test';

let tempDir: string;
let dbPath: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-engine-dashboard-'));
  dbPath = path.join(tempDir, 'knowledge.sqlite');

  const db = new KnowledgeDB(dbPath);
  db.init();
  db.insertReel({
    id: 'private-reel',
    url: 'https://private.example.test/source',
    shortcode: 'PRIVATE1',
    author: 'Test Author',
    author_id: 'private-author-id',
    description: 'Private source description',
    transcript: 'private transcript that must not cross the external boundary',
    ocr_text: 'private OCR output',
    thumbnail_url: 'https://private.example.test/thumbnail.jpg',
    github_urls: '["https://github.com/private/repository"]',
    action_items: '["private action"]',
    summary: 'A minimized dashboard summary',
    status: 'complete',
  });
  db.close();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function listen(options: DashboardServerOptions): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const server = startDashboardServer({
    ...options,
    port: 0,
    dbPath,
    installSignalHandlers: false,
  });
  if (!server.listening) await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Dashboard did not expose a TCP address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function bearer(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(token = TOKEN): Record<string, string> {
  const credentials = Buffer.from(`knowledge-engine:${token}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

describe.sequential('dashboard network boundary', () => {
  it('defaults to loopback and rejects non-loopback binding outside external mode', async () => {
    const config = resolveDashboardConfig({ port: 0, dbPath });
    expect(config.host).toBe('127.0.0.1');
    expect(config.external).toBe(false);
    expect(() => resolveDashboardConfig({ host: '0.0.0.0', dbPath })).toThrow(/external/i);

    const { server, baseUrl } = await listen({});
    try {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe('string');
      if (address && typeof address !== 'string') {
        expect(address.address).toBe('127.0.0.1');
      }

      const localResponse = await fetch(`${baseUrl}/api/reels?limit=10`);
      expect(localResponse.status).toBe(200);
      expect(localResponse.headers.get('access-control-allow-origin')).toBeNull();
      const localPayload = await localResponse.json() as {
        reels: Array<Record<string, unknown>>;
      };
      expect(localPayload.reels[0]).toHaveProperty('transcript');
      expect(localPayload.reels[0]).toHaveProperty('url');
    } finally {
      await close(server);
    }
  });

  it('refuses external mode without a strong token', () => {
    expect(() => resolveDashboardConfig({ external: true, dbPath })).toThrow(/token/i);
    expect(() => resolveDashboardConfig({
      external: true,
      token: 'too-short',
      dbPath,
    })).toThrow(/32/i);
  });

  it('rejects unauthenticated and incorrectly authenticated external requests', async () => {
    const { server, baseUrl } = await listen({
      external: true,
      host: '127.0.0.1',
      token: TOKEN,
      allowedOrigins: [TRUSTED_ORIGIN],
    });

    try {
      const anonymous = await fetch(`${baseUrl}/api/stats`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic /);

      const wrongToken = await fetch(`${baseUrl}/api/stats`, {
        headers: bearer(`${TOKEN}-wrong`),
      });
      expect(wrongToken.status).toBe(401);

      const dashboardShell = await fetch(`${baseUrl}/`);
      expect(dashboardShell.status).toBe(401);

      const authenticated = await fetch(`${baseUrl}/api/stats`, {
        headers: bearer(),
      });
      expect(authenticated.status).toBe(200);

      const browserAuth = await fetch(`${baseUrl}/`, {
        headers: basic(),
      });
      expect(browserAuth.status).toBe(200);
      expect(browserAuth.headers.get('content-type')).toContain('text/html');
    } finally {
      await close(server);
    }
  });

  it('allows only exact configured origins and never emits wildcard CORS', async () => {
    const { server, baseUrl } = await listen({
      external: true,
      host: '127.0.0.1',
      token: TOKEN,
      allowedOrigins: [TRUSTED_ORIGIN],
    });

    try {
      const trusted = await fetch(`${baseUrl}/api/stats`, {
        headers: {
          ...bearer(),
          Origin: TRUSTED_ORIGIN,
        },
      });
      expect(trusted.status).toBe(200);
      expect(trusted.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN);
      expect(trusted.headers.get('access-control-allow-credentials')).toBe('true');
      expect(trusted.headers.get('vary')).toContain('Origin');

      const untrusted = await fetch(`${baseUrl}/api/stats`, {
        headers: {
          ...bearer(),
          Origin: 'https://evil.example.test',
        },
      });
      expect(untrusted.status).toBe(403);
      expect(untrusted.headers.get('access-control-allow-origin')).toBeNull();

      const suffixAttack = await fetch(`${baseUrl}/api/stats`, {
        headers: {
          ...bearer(),
          Origin: `${TRUSTED_ORIGIN}.evil.example`,
        },
      });
      expect(suffixAttack.status).toBe(403);
      expect(suffixAttack.headers.get('access-control-allow-origin')).toBeNull();

      const originless = await fetch(`${baseUrl}/api/stats`, {
        headers: bearer(),
      });
      expect(originless.status).toBe(200);
      expect(originless.headers.get('access-control-allow-origin')).toBeNull();

      const preflight = await fetch(`${baseUrl}/api/stats`, {
        method: 'OPTIONS',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN);
      expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization');
      expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
      expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');

      const hostilePreflight = await fetch(`${baseUrl}/api/stats`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.test',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect(hostilePreflight.status).toBe(403);
      expect(hostilePreflight.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('minimizes reel data returned through the authenticated external API', async () => {
    const { server, baseUrl } = await listen({
      external: true,
      host: '127.0.0.1',
      token: TOKEN,
    });

    try {
      const response = await fetch(`${baseUrl}/api/reels?limit=10`, {
        headers: bearer(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const payload = await response.json() as { reels: Array<Record<string, unknown>> };
      expect(payload.reels).toHaveLength(1);
      expect(payload.reels[0]).toMatchObject({
        id: 'private-reel',
        shortcode: 'PRIVATE1',
        summary: 'A minimized dashboard summary',
      });
      expect(payload.reels[0]).not.toHaveProperty('url');
      expect(payload.reels[0]).not.toHaveProperty('transcript');
      expect(payload.reels[0]).not.toHaveProperty('ocr_text');
      expect(payload.reels[0]).not.toHaveProperty('thumbnail_url');
      expect(payload.reels[0]).not.toHaveProperty('github_urls');
      expect(payload.reels[0]).not.toHaveProperty('action_items');
      expect(JSON.stringify(payload)).not.toContain('private transcript');
      expect(JSON.stringify(payload)).not.toContain('private.example.test');
    } finally {
      await close(server);
    }
  });

  it('recursively strips private fields before external API or event delivery', () => {
    const minimized = minimizeExternalPayload({
      summary: 'safe summary',
      nested: {
        transcript: 'private transcript',
        ocr_text: 'private OCR',
        url: 'https://private.example.test',
        metadata: { private: true },
        retained: 'safe value',
      },
    });

    expect(minimized).toEqual({
      summary: 'safe summary',
      nested: { retained: 'safe value' },
    });
  });

  it('keeps stored values out of inline JavaScript handlers', async () => {
    const html = await readFile(
      path.resolve(import.meta.dirname, '../src/dashboard/index.html'),
      'utf8',
    );
    const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/gi)]
      .map(match => match[1]);

    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers.every(handler => !handler.includes('+'))).toBe(true);
    expect(handlers.every(handler => !handler.includes('esc('))).toBe(true);
    expect(html).toContain('function attr(str)');
    expect(html).toContain('function cssToken(value)');
  });

  it('does not return internal exception details in external mode', async () => {
    const { server, baseUrl } = await listen({
      external: true,
      host: '127.0.0.1',
      token: TOKEN,
    });

    try {
      const response = await fetch(`${baseUrl}/api/reels?limit=not-a-number`, {
        headers: bearer(),
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    } finally {
      await close(server);
    }
  });
});
