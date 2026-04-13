import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeDB } from '../src/storage/db.js';

let db: KnowledgeDB;

beforeEach(() => {
  // Use in-memory SQLite for tests
  db = new KnowledgeDB(':memory:');
  db.init();
});

afterEach(() => {
  db.close();
});

// ── Schema migration tests ──────────────────────────────────────────────

describe('schema migrations', () => {
  it('creates all tables', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('reels');
    expect(tableNames).toContain('entities');
    expect(tableNames).toContain('relationships');
    expect(tableNames).toContain('reel_entities');
    expect(tableNames).toContain('facts');
    expect(tableNames).toContain('reel_tags');
    expect(tableNames).toContain('topics');
    expect(tableNames).toContain('reel_topics');
    expect(tableNames).toContain('processing_log');
    expect(tableNames).toContain('schema_migrations');
  });

  it('creates FTS5 virtual table', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'reels_fts%'")
      .all() as { name: string }[];

    // FTS5 creates multiple internal tables
    expect(tables.length).toBeGreaterThan(0);
  });

  it('is idempotent -- running twice does not error', () => {
    expect(() => db.init()).not.toThrow();
  });

  it('records migration version', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBe(1);
  });
});

// ── Reel CRUD tests ─────────────────────────────────────────────────────

describe('reel operations', () => {
  const testReel = {
    id: 'reel-001',
    url: 'https://instagram.com/reel/ABC123/',
    shortcode: 'ABC123',
    author: 'testuser',
    author_id: 'testuser',
    title: 'Test Reel',
    description: 'A test reel description',
    duration: 30,
    view_count: 1000,
    like_count: 50,
    comment_count: 10,
    upload_date: '20240101',
    thumbnail_url: 'https://example.com/thumb.jpg',
    transcript: 'This is a test transcript',
    ocr_text: 'Screen text here',
    summary: 'A reel about testing',
    content_type: 'tutorial',
    sentiment: 'positive',
    hype_level: 'grounded',
    implementation_readiness: 'production',
    github_urls: '["https://github.com/test/repo"]',
    action_items: '["Try this tool"]',
    status: 'complete',
  };

  it('inserts and retrieves a reel by shortcode', () => {
    db.insertReel(testReel);
    const found = db.getReelByShortcode('ABC123');
    expect(found).toBeDefined();
    expect(found!.id).toBe('reel-001');
    expect(found!.author).toBe('testuser');
    expect(found!.summary).toBe('A reel about testing');
  });

  it('retrieves a reel by URL', () => {
    db.insertReel(testReel);
    const found = db.getReelByUrl('https://instagram.com/reel/ABC123/');
    expect(found).toBeDefined();
    expect(found!.shortcode).toBe('ABC123');
  });

  it('INSERT OR IGNORE skips duplicate URLs', () => {
    db.insertReel(testReel);
    // Insert again -- should not throw
    db.insertReel({ ...testReel, id: 'reel-002' });
    // Original reel should still be there
    const found = db.getReelByShortcode('ABC123');
    expect(found!.id).toBe('reel-001');
  });

  it('reelExists returns correct results', () => {
    expect(db.reelExists(testReel.url)).toBe(false);
    db.insertReel(testReel);
    expect(db.reelExists(testReel.url)).toBe(true);
    expect(db.reelExists('https://instagram.com/reel/NOPE/')).toBe(false);
  });

  it('updates reel status', () => {
    db.insertReel(testReel);
    db.updateReelStatus('reel-001', 'error', 'Something went wrong');
    const found = db.getReelByShortcode('ABC123');
    expect(found!.status).toBe('error');
    expect(found!.error_message).toBe('Something went wrong');
  });

  it('getRecentReels returns correct order and limit', () => {
    db.insertReel(testReel);
    db.insertReel({ ...testReel, id: 'reel-002', url: 'https://instagram.com/reel/DEF456/', shortcode: 'DEF456' });
    db.insertReel({ ...testReel, id: 'reel-003', url: 'https://instagram.com/reel/GHI789/', shortcode: 'GHI789' });

    const recent = db.getRecentReels(2);
    expect(recent).toHaveLength(2);
  });
});

// ── Entity tests ────────────────────────────────────────────────────────

describe('entity operations', () => {
  it('creates a new entity', () => {
    const id = db.upsertEntity({
      name: 'React',
      type: 'framework',
      description: 'A JavaScript UI library',
      aliases: ['ReactJS', 'React.js'],
    });

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
  });

  it('deduplicates by canonical name (case-insensitive)', () => {
    const id1 = db.upsertEntity({ name: 'React', type: 'framework', description: 'v1' });
    const id2 = db.upsertEntity({ name: 'react', type: 'framework', description: 'v2' });
    const id3 = db.upsertEntity({ name: 'REACT', type: 'framework', description: '' });

    // All should return the same ID
    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
  });

  it('increments mention_count on duplicate', () => {
    db.upsertEntity({ name: 'React', type: 'framework' });
    db.upsertEntity({ name: 'react', type: 'framework' });

    const entity = db.raw
      .prepare("SELECT mention_count FROM entities WHERE canonical_name = 'react'")
      .get() as { mention_count: number };

    expect(entity.mention_count).toBe(2);
  });

  it('links entity to reel', () => {
    const reelId = 'reel-test';
    db.insertReel({ id: reelId, url: 'https://instagram.com/reel/TEST/', shortcode: 'TEST' });
    const entityId = db.upsertEntity({ name: 'Node.js', type: 'tool' });

    db.linkReelEntity(reelId, entityId, 'mentioned in transcript', 0.9, 'transcript');

    const link = db.raw
      .prepare('SELECT * FROM reel_entities WHERE reel_id = ? AND entity_id = ?')
      .get(reelId, entityId) as Record<string, unknown>;

    expect(link).toBeDefined();
    expect(link.confidence).toBe(0.9);
  });
});

// ── Relationship tests ──────────────────────────────────────────────────

describe('relationship operations', () => {
  it('creates a new relationship', () => {
    const sourceId = db.upsertEntity({ name: 'TensorFlow', type: 'framework' });
    const targetId = db.upsertEntity({ name: 'PyTorch', type: 'framework' });

    const relId = db.upsertRelationship(sourceId, targetId, 'similar_to', 'Both are ML frameworks');

    expect(relId).toBeDefined();
    expect(typeof relId).toBe('string');
  });

  it('deduplicates and increments evidence_count', () => {
    const sourceId = db.upsertEntity({ name: 'A', type: 'tool' });
    const targetId = db.upsertEntity({ name: 'B', type: 'tool' });

    const id1 = db.upsertRelationship(sourceId, targetId, 'improves', 'First evidence');
    const id2 = db.upsertRelationship(sourceId, targetId, 'improves', 'Second evidence');

    expect(id2).toBe(id1);

    const rel = db.raw
      .prepare('SELECT evidence_count FROM relationships WHERE id = ?')
      .get(id1) as { evidence_count: number };

    expect(rel.evidence_count).toBe(2);
  });
});

// ── Facts & Tags tests ──────────────────────────────────────────────────

describe('facts and tags', () => {
  const reelId = 'reel-facts';

  beforeEach(() => {
    db.insertReel({ id: reelId, url: 'https://instagram.com/reel/FACTS/', shortcode: 'FACTS' });
  });

  it('inserts facts', () => {
    const factId = db.insertFact({
      reelId,
      claim: 'GPT-4 can pass the bar exam',
      confidence: 0.85,
      source: 'transcript',
    });

    expect(factId).toBeDefined();

    const fact = db.raw
      .prepare('SELECT * FROM facts WHERE id = ?')
      .get(factId) as Record<string, unknown>;

    expect(fact.claim).toBe('GPT-4 can pass the bar exam');
    expect(fact.confidence).toBe(0.85);
  });

  it('adds tags to a reel', () => {
    db.addReelTags(reelId, ['ai', 'machine_learning', 'GPT']);

    const tags = db.raw
      .prepare('SELECT tag FROM reel_tags WHERE reel_id = ? ORDER BY tag')
      .all(reelId) as { tag: string }[];

    expect(tags.map(t => t.tag)).toEqual(['ai', 'gpt', 'machine_learning']);
  });

  it('ignores duplicate tags', () => {
    db.addReelTags(reelId, ['ai', 'ml']);
    db.addReelTags(reelId, ['ai', 'nlp']);

    const tags = db.raw
      .prepare('SELECT tag FROM reel_tags WHERE reel_id = ? ORDER BY tag')
      .all(reelId) as { tag: string }[];

    expect(tags.map(t => t.tag)).toEqual(['ai', 'ml', 'nlp']);
  });
});

// ── Topics tests ────────────────────────────────────────────────────────

describe('topic operations', () => {
  it('creates and retrieves a topic', () => {
    const id = db.upsertTopic('Machine Learning', 'ML and AI topics');
    expect(id).toBeDefined();
  });

  it('deduplicates topics by name', () => {
    const id1 = db.upsertTopic('Machine Learning');
    const id2 = db.upsertTopic('Machine Learning', 'Updated description');
    expect(id2).toBe(id1);
  });

  it('links reel to topic and updates count', () => {
    const reelId = 'reel-topic';
    db.insertReel({ id: reelId, url: 'https://instagram.com/reel/TOPIC/', shortcode: 'TOPIC' });
    const topicId = db.upsertTopic('AI');

    db.linkReelTopic(reelId, topicId, 0.95);

    const topic = db.raw
      .prepare('SELECT reel_count FROM topics WHERE id = ?')
      .get(topicId) as { reel_count: number };

    expect(topic.reel_count).toBe(1);
  });
});

// ── FTS5 search tests ───────────────────────────────────────────────────

describe('FTS5 search', () => {
  it('finds reels by transcript content', () => {
    db.insertReel({
      id: 'reel-fts1',
      url: 'https://instagram.com/reel/FTS1/',
      shortcode: 'FTS1',
      summary: 'Using transformers for NLP tasks',
      transcript: 'Today we discuss transformer architecture and attention mechanisms',
    });

    db.insertReel({
      id: 'reel-fts2',
      url: 'https://instagram.com/reel/FTS2/',
      shortcode: 'FTS2',
      summary: 'React hooks tutorial',
      transcript: 'Learn useState and useEffect in React',
    });

    const results = db.searchReelsFTS('transformer', 10);
    expect(results).toHaveLength(1);
    expect(results[0].shortcode).toBe('FTS1');
  });

  it('finds reels by summary content', () => {
    db.insertReel({
      id: 'reel-fts3',
      url: 'https://instagram.com/reel/FTS3/',
      shortcode: 'FTS3',
      summary: 'Building microservices with Kubernetes',
      transcript: 'Container orchestration tutorial',
    });

    const results = db.searchReelsFTS('kubernetes', 10);
    expect(results).toHaveLength(1);
    expect(results[0].shortcode).toBe('FTS3');
  });

  it('returns empty array for no matches', () => {
    const results = db.searchReelsFTS('xyznonexistent', 10);
    expect(results).toHaveLength(0);
  });
});

// ── Stats tests ─────────────────────────────────────────────────────────

describe('getStats', () => {
  it('returns correct counts on empty database', () => {
    const stats = db.getStats();
    expect(stats.totalReels).toBe(0);
    expect(stats.totalEntities).toBe(0);
    expect(stats.totalRelationships).toBe(0);
    expect(stats.totalFacts).toBe(0);
    expect(stats.totalTopics).toBe(0);
    expect(stats.lastIngested).toBeNull();
  });

  it('returns correct counts after inserts', () => {
    db.insertReel({
      id: 'reel-stats',
      url: 'https://instagram.com/reel/STATS/',
      shortcode: 'STATS',
      content_type: 'tutorial',
      status: 'complete',
    });

    const e1 = db.upsertEntity({ name: 'Tool A', type: 'tool' });
    const e2 = db.upsertEntity({ name: 'Tool B', type: 'tool' });
    db.upsertRelationship(e1, e2, 'similar_to', 'Both tools');
    db.insertFact({ reelId: 'reel-stats', claim: 'A fact', confidence: 0.9, source: 'transcript' });
    db.upsertTopic('Testing');

    const stats = db.getStats();
    expect(stats.totalReels).toBe(1);
    expect(stats.totalEntities).toBe(2);
    expect(stats.totalRelationships).toBe(1);
    expect(stats.totalFacts).toBe(1);
    expect(stats.totalTopics).toBe(1);
    expect(stats.reelsByCategory.tutorial).toBe(1);
    expect(stats.reelsByStatus.complete).toBe(1);
  });
});

// ── Processing log tests ────────────────────────────────────────────────

describe('processing log', () => {
  it('logs processing steps', () => {
    const reelId = 'reel-log';
    db.insertReel({ id: reelId, url: 'https://instagram.com/reel/LOG/', shortcode: 'LOG' });

    db.logProcessingStep(reelId, 'download', 'complete', { durationMs: 5000 });
    db.logProcessingStep(reelId, 'transcribe', 'error', { error: 'Timeout' });

    const logs = db.raw
      .prepare('SELECT * FROM processing_log WHERE reel_id = ? ORDER BY id')
      .all(reelId) as Record<string, unknown>[];

    expect(logs).toHaveLength(2);
    expect(logs[0].step).toBe('download');
    expect(logs[0].status).toBe('complete');
    expect(logs[0].duration_ms).toBe(5000);
    expect(logs[1].step).toBe('transcribe');
    expect(logs[1].error_message).toBe('Timeout');
  });
});
