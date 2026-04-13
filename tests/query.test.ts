import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeDB } from '../src/storage/db.js';
import { generateSimpleEmbedding, cosineSimilarity } from '../src/storage/embeddings.js';
import { searchByVector, storeEmbedding } from '../src/storage/vector-search.js';
import { fuseScores, computeRecencyScore, DEFAULT_WEIGHTS } from '../src/query/ranker.js';
import { queryKnowledge } from '../src/query/engine.js';

let db: KnowledgeDB;

beforeEach(() => {
  db = new KnowledgeDB(':memory:');
  db.init();
});

afterEach(() => {
  db.close();
});

// ── Helper to insert a test reel ─────────────────────────────────────────

function insertTestReel(id: string, shortcode: string, opts: {
  summary?: string;
  transcript?: string;
  content_type?: string;
  author_id?: string;
} = {}): void {
  db.insertReel({
    id,
    url: `https://instagram.com/reel/${shortcode}/`,
    shortcode,
    summary: opts.summary ?? `Summary for ${shortcode}`,
    transcript: opts.transcript ?? `Transcript for ${shortcode}`,
    content_type: opts.content_type ?? 'general',
    author_id: opts.author_id ?? 'testuser',
    status: 'complete',
  });
}

// ── Embedding tests ──────────────────────────────────────────────────────

describe('generateSimpleEmbedding', () => {
  it('produces a 256-dimension vector', () => {
    const embedding = generateSimpleEmbedding('test text');
    expect(embedding).toHaveLength(256);
  });

  it('produces consistent results -- same text yields same embedding', () => {
    const e1 = generateSimpleEmbedding('transformer attention mechanism');
    const e2 = generateSimpleEmbedding('transformer attention mechanism');
    expect(e1).toEqual(e2);
  });

  it('produces different embeddings for different texts', () => {
    const e1 = generateSimpleEmbedding('react hooks tutorial');
    const e2 = generateSimpleEmbedding('kubernetes deployment guide');
    expect(e1).not.toEqual(e2);
  });

  it('handles empty string', () => {
    const e = generateSimpleEmbedding('');
    expect(e).toHaveLength(256);
    // All zeros for empty input
    expect(e.every(v => v === 0)).toBe(true);
  });

  it('produces L2-normalized vectors (unit length)', () => {
    const e = generateSimpleEmbedding('machine learning deep neural networks');
    const norm = Math.sqrt(e.reduce((sum, v) => sum + v * v, 0));
    // Should be approximately 1.0 (unit vector)
    expect(norm).toBeCloseTo(1.0, 5);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = generateSimpleEmbedding('test');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns higher similarity for related texts', () => {
    const e1 = generateSimpleEmbedding('machine learning neural network');
    const e2 = generateSimpleEmbedding('deep learning neural network');
    const e3 = generateSimpleEmbedding('cooking recipes pasta sauce');

    const simRelated = cosineSimilarity(e1, e2);
    const simUnrelated = cosineSimilarity(e1, e3);

    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it('returns 0 for zero vectors', () => {
    const zero = new Array(256).fill(0);
    const v = generateSimpleEmbedding('test');
    expect(cosineSimilarity(zero, v)).toBe(0);
  });
});

// ── Vector search tests ──────────────────────────────────────────────────

describe('vector search', () => {
  it('stores and retrieves embeddings', () => {
    insertTestReel('reel-v1', 'V1', { summary: 'React hooks and state management' });
    const embedding = generateSimpleEmbedding('React hooks and state management');
    storeEmbedding(db, 'reel-v1', embedding);

    const allEmbeddings = db.getAllEmbeddings();
    expect(allEmbeddings).toHaveLength(1);
    expect(allEmbeddings[0].reel_id).toBe('reel-v1');
  });

  it('finds similar reels by vector search', () => {
    insertTestReel('reel-v1', 'V1', { summary: 'React hooks tutorial useState useEffect' });
    insertTestReel('reel-v2', 'V2', { summary: 'Kubernetes pod deployment scaling' });

    storeEmbedding(db, 'reel-v1', generateSimpleEmbedding('React hooks tutorial useState useEffect'));
    storeEmbedding(db, 'reel-v2', generateSimpleEmbedding('Kubernetes pod deployment scaling'));

    const query = generateSimpleEmbedding('React state management hooks');
    const results = searchByVector(db, query, 10);

    expect(results).toHaveLength(2);
    // React-related reel should score higher
    expect(results[0].reelId).toBe('reel-v1');
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });
});

// ── Score fusion tests ───────────────────────────────────────────────────

describe('fuseScores', () => {
  it('produces correct ranking order', () => {
    const vectorResults = [
      { reelId: 'reel-1', score: 0.9 },
      { reelId: 'reel-2', score: 0.3 },
    ];
    const ftsResults = [
      { reelId: 'reel-1', score: 0.8 },
      { reelId: 'reel-3', score: 0.7 },
    ];
    const graphResults = [
      { reelId: 'reel-2', score: 0.5 },
      { reelId: 'reel-3', score: 0.4 },
    ];

    const now = new Date().toISOString();
    const dates = new Map([
      ['reel-1', now],
      ['reel-2', now],
      ['reel-3', now],
    ]);

    const ranked = fuseScores(vectorResults, ftsResults, graphResults, dates);

    expect(ranked).toHaveLength(3);
    // reel-1 should be first (high vector + high keyword)
    expect(ranked[0].reelId).toBe('reel-1');
    // All should have score breakdowns
    expect(ranked[0].scoreBreakdown).toBeDefined();
    expect(ranked[0].scoreBreakdown.vector).toBeGreaterThan(0);
    expect(ranked[0].scoreBreakdown.keyword).toBeGreaterThan(0);
  });

  it('respects custom weights', () => {
    const vectorResults = [{ reelId: 'reel-1', score: 1.0 }];
    const ftsResults = [{ reelId: 'reel-2', score: 1.0 }];
    const graphResults: Array<{ reelId: string; score: number }> = [];

    const now = new Date().toISOString();
    const dates = new Map([
      ['reel-1', now],
      ['reel-2', now],
    ]);

    // Weight vector much higher
    const ranked = fuseScores(vectorResults, ftsResults, graphResults, dates, {
      vector: 0.9,
      keyword: 0.05,
      graph: 0.0,
      recency: 0.05,
    });

    expect(ranked[0].reelId).toBe('reel-1');
  });

  it('handles empty inputs', () => {
    const ranked = fuseScores([], [], [], new Map());
    expect(ranked).toHaveLength(0);
  });
});

describe('computeRecencyScore', () => {
  it('returns ~1.0 for now', () => {
    const score = computeRecencyScore(new Date().toISOString());
    expect(score).toBeGreaterThan(0.99);
  });

  it('returns ~0.5 for 30 days ago', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const score = computeRecencyScore(thirtyDaysAgo.toISOString());
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('returns lower score for older dates', () => {
    const recent = computeRecencyScore(new Date().toISOString());
    const old = computeRecencyScore(new Date('2020-01-01').toISOString());
    expect(recent).toBeGreaterThan(old);
  });

  it('returns ~0.25 for 60 days ago', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const score = computeRecencyScore(sixtyDaysAgo.toISOString());
    expect(score).toBeCloseTo(0.25, 1);
  });
});

// ── Query engine integration tests ───────────────────────────────────────

describe('queryKnowledge integration', () => {
  it('returns results from FTS search', () => {
    insertTestReel('reel-q1', 'Q1', {
      summary: 'Transformer architecture for natural language processing',
      transcript: 'Self-attention is the key mechanism in transformers',
    });

    const results = queryKnowledge(db, 'transformer', { limit: 10 });

    expect(results.totalResults).toBeGreaterThanOrEqual(1);
    expect(results.query).toBe('transformer');
    expect(results.timingMs).toBeGreaterThanOrEqual(0);
    expect(results.reels[0].reelId).toBe('reel-q1');
  });

  it('combines FTS and entity graph signals', () => {
    insertTestReel('reel-q2', 'Q2', {
      summary: 'React hooks are great for state management',
      transcript: 'useState and useEffect are essential React hooks',
    });

    // Add an entity linked to this reel
    const entityId = db.upsertEntity({ name: 'React', type: 'framework', description: 'UI library' });
    db.linkReelEntity('reel-q2', entityId, 'React hooks discussion', 0.95, 'transcript');

    const results = queryKnowledge(db, 'react', { limit: 10 });

    expect(results.totalResults).toBeGreaterThanOrEqual(1);
    expect(results.entities.length).toBeGreaterThanOrEqual(1);
  });

  it('includes facts from matched reels', () => {
    insertTestReel('reel-q3', 'Q3', {
      summary: 'GPT-4 benchmark results and capabilities',
      transcript: 'GPT-4 scores high on various benchmarks',
    });

    db.insertFact({
      reelId: 'reel-q3',
      claim: 'GPT-4 passes bar exam',
      confidence: 0.9,
      source: 'transcript',
    });

    const results = queryKnowledge(db, 'GPT', {
      limit: 10,
      includeFacts: true,
    });

    expect(results.facts.length).toBeGreaterThanOrEqual(1);
    expect(results.facts[0].claim).toContain('bar exam');
  });

  it('returns empty results for no match', () => {
    const results = queryKnowledge(db, 'xyznonexistent', { limit: 10 });
    expect(results.totalResults).toBe(0);
    expect(results.reels).toHaveLength(0);
  });

  it('returns results with vector signal when embeddings exist', () => {
    insertTestReel('reel-q4', 'Q4', {
      summary: 'PyTorch deep learning neural networks',
      transcript: 'Training deep neural networks with PyTorch',
    });

    // Store embedding
    storeEmbedding(db, 'reel-q4', generateSimpleEmbedding('PyTorch deep learning neural networks'));

    const results = queryKnowledge(db, 'deep learning', { limit: 10 });
    expect(results.totalResults).toBeGreaterThanOrEqual(1);
  });
});
