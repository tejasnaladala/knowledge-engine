import type Database from 'better-sqlite3';

// ── Schema SQL ────────────────────────────────────────────────────────────

export const SCHEMA_SQL = `
-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Core reels table
CREATE TABLE IF NOT EXISTS reels (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  shortcode TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'instagram_reel',
  author TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  upload_date TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  ocr_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'general',
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  hype_level TEXT NOT NULL DEFAULT 'grounded',
  implementation_readiness TEXT NOT NULL DEFAULT 'concept',
  github_urls TEXT NOT NULL DEFAULT '[]',
  action_items TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entities (tools, repos, models, people, etc.)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  mention_count INTEGER NOT NULL DEFAULT 1
);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entities(id),
  target_entity_id TEXT NOT NULL REFERENCES entities(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_entity_id, target_entity_id, type)
);

-- Junction: which entities appear in which reels
CREATE TABLE IF NOT EXISTS reel_entities (
  reel_id TEXT NOT NULL REFERENCES reels(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  context TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'transcript',
  PRIMARY KEY (reel_id, entity_id)
);

-- Facts extracted from reels
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  reel_id TEXT NOT NULL REFERENCES reels(id),
  claim TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'transcript',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tags on reels
CREATE TABLE IF NOT EXISTS reel_tags (
  reel_id TEXT NOT NULL REFERENCES reels(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (reel_id, tag)
);

-- Topics
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  reel_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction: reel <-> topic with relevance
CREATE TABLE IF NOT EXISTS reel_topics (
  reel_id TEXT NOT NULL REFERENCES reels(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  relevance REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (reel_id, topic_id)
);

-- Embeddings for vector similarity search
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  reel_id TEXT NOT NULL UNIQUE,
  embedding TEXT NOT NULL,  -- JSON array of floats
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (reel_id) REFERENCES reels(id)
);

-- Processing log for debugging
CREATE TABLE IF NOT EXISTS processing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id TEXT NOT NULL REFERENCES reels(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reels_status ON reels(status);
CREATE INDEX IF NOT EXISTS idx_reels_source_type ON reels(source_type);
CREATE INDEX IF NOT EXISTS idx_reels_content_type ON reels(content_type);
CREATE INDEX IF NOT EXISTS idx_reels_author_id ON reels(author_id);
CREATE INDEX IF NOT EXISTS idx_reels_created_at ON reels(created_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_reel ON facts(reel_id);
CREATE INDEX IF NOT EXISTS idx_reel_tags_tag ON reel_tags(tag);
CREATE INDEX IF NOT EXISTS idx_processing_log_reel ON processing_log(reel_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_reel ON embeddings(reel_id);

-- FTS5 virtual table for full-text search across reel content
CREATE VIRTUAL TABLE IF NOT EXISTS reels_fts USING fts5(
  summary,
  description,
  transcript,
  ocr_text,
  content='reels',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS reels_ai AFTER INSERT ON reels BEGIN
  INSERT INTO reels_fts(rowid, summary, description, transcript, ocr_text)
  VALUES (new.rowid, new.summary, new.description, new.transcript, new.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS reels_ad AFTER DELETE ON reels BEGIN
  INSERT INTO reels_fts(reels_fts, rowid, summary, description, transcript, ocr_text)
  VALUES ('delete', old.rowid, old.summary, old.description, old.transcript, old.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS reels_au AFTER UPDATE ON reels BEGIN
  INSERT INTO reels_fts(reels_fts, rowid, summary, description, transcript, ocr_text)
  VALUES ('delete', old.rowid, old.summary, old.description, old.transcript, old.ocr_text);
  INSERT INTO reels_fts(rowid, summary, description, transcript, ocr_text)
  VALUES (new.rowid, new.summary, new.description, new.transcript, new.ocr_text);
END;
`;

// ── Migration runner ──────────────────────────────────────────────────────

/**
 * Run all schema migrations idempotently.
 * Uses WAL mode for better concurrent access.
 */
export function runMigrations(db: Database.Database): void {
  // Enable WAL mode for performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run the full schema -- all CREATE IF NOT EXISTS, so idempotent
  db.exec(SCHEMA_SQL);

  // Record migration version (idempotent)
  const existing = db
    .prepare('SELECT version FROM schema_migrations WHERE version = ?')
    .get(1);
  if (!existing) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(1);
  }

  // ── Migration v2: add source_type column to reels ───────────────────
  // For existing databases that already have the reels table but lack the
  // source_type column. Uses PRAGMA table_info to check before altering.
  const v2 = db
    .prepare('SELECT version FROM schema_migrations WHERE version = ?')
    .get(2);
  if (!v2) {
    const columns = db.pragma('table_info(reels)') as Array<{ name: string }>;
    const hasSourceType = columns.some(col => col.name === 'source_type');
    if (!hasSourceType) {
      db.exec(`ALTER TABLE reels ADD COLUMN source_type TEXT NOT NULL DEFAULT 'instagram_reel'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_reels_source_type ON reels(source_type)`);
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(2);
  }
}
