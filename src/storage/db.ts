import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from './schema.js';
import type { KnowledgeStats, StoredEntity, StoredReel } from '../types.js';

/**
 * Typed wrapper around the knowledge-engine SQLite database.
 * All methods use prepared statements for performance.
 */
export class KnowledgeDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Run schema migrations. Call once after construction. */
  init(): void {
    runMigrations(this.db);
  }

  /** Get the underlying database instance (for testing/advanced use). */
  get raw(): Database.Database {
    return this.db;
  }

  // ── Reels ─────────────────────────────────────────────────────────────

  /**
   * Insert a new reel. Uses INSERT OR IGNORE to skip duplicates (by URL).
   * Returns the reel ID (existing or new).
   */
  insertReel(reel: {
    id: string;
    url: string;
    shortcode: string;
    source_type?: string;
    author?: string;
    author_id?: string;
    title?: string;
    description?: string;
    duration?: number;
    view_count?: number;
    like_count?: number;
    comment_count?: number;
    upload_date?: string;
    thumbnail_url?: string;
    transcript?: string;
    ocr_text?: string;
    summary?: string;
    content_type?: string;
    sentiment?: string;
    hype_level?: string;
    implementation_readiness?: string;
    github_urls?: string;
    action_items?: string;
    status?: string;
  }): string {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO reels (
        id, url, shortcode, source_type, author, author_id, title, description,
        duration, view_count, like_count, comment_count, upload_date,
        thumbnail_url, transcript, ocr_text, summary, content_type,
        sentiment, hype_level, implementation_readiness, github_urls,
        action_items, status
      ) VALUES (
        @id, @url, @shortcode, @source_type, @author, @author_id, @title, @description,
        @duration, @view_count, @like_count, @comment_count, @upload_date,
        @thumbnail_url, @transcript, @ocr_text, @summary, @content_type,
        @sentiment, @hype_level, @implementation_readiness, @github_urls,
        @action_items, @status
      )
    `);

    stmt.run({
      id: reel.id,
      url: reel.url,
      shortcode: reel.shortcode,
      source_type: reel.source_type ?? 'instagram_reel',
      author: reel.author ?? '',
      author_id: reel.author_id ?? '',
      title: reel.title ?? '',
      description: reel.description ?? '',
      duration: reel.duration ?? 0,
      view_count: reel.view_count ?? 0,
      like_count: reel.like_count ?? 0,
      comment_count: reel.comment_count ?? 0,
      upload_date: reel.upload_date ?? '',
      thumbnail_url: reel.thumbnail_url ?? '',
      transcript: reel.transcript ?? '',
      ocr_text: reel.ocr_text ?? '',
      summary: reel.summary ?? '',
      content_type: reel.content_type ?? 'general',
      sentiment: reel.sentiment ?? 'neutral',
      hype_level: reel.hype_level ?? 'grounded',
      implementation_readiness: reel.implementation_readiness ?? 'concept',
      github_urls: reel.github_urls ?? '[]',
      action_items: reel.action_items ?? '[]',
      status: reel.status ?? 'pending',
    });

    return reel.id;
  }

  /** Update a reel's processing status. */
  updateReelStatus(id: string, status: string, error?: string): void {
    this.db.prepare(`
      UPDATE reels
      SET status = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, error ?? null, id);
  }

  /** Look up a reel by its shortcode. */
  getReelByShortcode(shortcode: string): StoredReel | undefined {
    return this.db
      .prepare('SELECT * FROM reels WHERE shortcode = ?')
      .get(shortcode) as StoredReel | undefined;
  }

  /** Look up a reel by its URL. */
  getReelByUrl(url: string): StoredReel | undefined {
    return this.db
      .prepare('SELECT * FROM reels WHERE url = ?')
      .get(url) as StoredReel | undefined;
  }

  /** Check if a reel with this URL already exists. */
  reelExists(url: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM reels WHERE url = ?')
      .get(url);
    return row !== undefined;
  }

  /** Get the most recent reels. */
  getRecentReels(limit: number = 10): StoredReel[] {
    return this.db
      .prepare('SELECT * FROM reels ORDER BY created_at DESC LIMIT ?')
      .all(limit) as StoredReel[];
  }

  // ── Entities ──────────────────────────────────────────────────────────

  /**
   * Upsert an entity by canonical name (lowercase + trim for dedup).
   * If it already exists, increments mention_count and updates description if provided.
   * Returns the entity ID.
   */
  upsertEntity(entity: {
    name: string;
    type: string;
    description?: string;
    aliases?: string[];
  }): string {
    const canonicalName = entity.name.toLowerCase().trim();
    const existing = this.db
      .prepare('SELECT id, mention_count FROM entities WHERE canonical_name = ?')
      .get(canonicalName) as { id: string; mention_count: number } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE entities
        SET mention_count = mention_count + 1,
            description = CASE WHEN ? != '' THEN ? ELSE description END
        WHERE id = ?
      `).run(entity.description ?? '', entity.description ?? '', existing.id);
      return existing.id;
    }

    const id = uuid();
    this.db.prepare(`
      INSERT INTO entities (id, canonical_name, display_name, type, description, aliases)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      canonicalName,
      entity.name,
      entity.type,
      entity.description ?? '',
      JSON.stringify(entity.aliases ?? []),
    );

    return id;
  }

  /** Link a reel to an entity. */
  linkReelEntity(
    reelId: string,
    entityId: string,
    context: string,
    confidence: number,
    source: string,
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO reel_entities (reel_id, entity_id, context, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(reelId, entityId, context, confidence, source);
  }

  // ── Relationships ─────────────────────────────────────────────────────

  /**
   * Upsert a relationship between two entities.
   * If it already exists (same source, target, type), increments evidence count.
   * Returns the relationship ID.
   */
  upsertRelationship(
    sourceEntityId: string,
    targetEntityId: string,
    type: string,
    description: string,
  ): string {
    const existing = this.db.prepare(`
      SELECT id FROM relationships
      WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?
    `).get(sourceEntityId, targetEntityId, type) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE relationships
        SET evidence_count = evidence_count + 1,
            description = CASE WHEN ? != '' THEN ? ELSE description END
        WHERE id = ?
      `).run(description, description, existing.id);
      return existing.id;
    }

    const id = uuid();
    this.db.prepare(`
      INSERT INTO relationships (id, source_entity_id, target_entity_id, type, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sourceEntityId, targetEntityId, type, description);

    return id;
  }

  // ── Facts ─────────────────────────────────────────────────────────────

  /** Insert a fact extracted from a reel. */
  insertFact(fact: {
    reelId: string;
    claim: string;
    confidence: number;
    source: string;
  }): string {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO facts (id, reel_id, claim, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, fact.reelId, fact.claim, fact.confidence, fact.source);
    return id;
  }

  // ── Tags ──────────────────────────────────────────────────────────────

  /** Add tags to a reel (ignores duplicates). */
  addReelTags(reelId: string, tags: string[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO reel_tags (reel_id, tag) VALUES (?, ?)',
    );
    const insertMany = this.db.transaction((tagList: string[]) => {
      for (const tag of tagList) {
        stmt.run(reelId, tag.toLowerCase().trim());
      }
    });
    insertMany(tags);
  }

  // ── Topics ────────────────────────────────────────────────────────────

  /** Upsert a topic by name. Returns the topic ID. */
  upsertTopic(name: string, description?: string): string {
    const existing = this.db
      .prepare('SELECT id FROM topics WHERE name = ?')
      .get(name) as { id: string } | undefined;

    if (existing) {
      if (description) {
        this.db.prepare('UPDATE topics SET description = ? WHERE id = ?')
          .run(description, existing.id);
      }
      return existing.id;
    }

    const id = uuid();
    this.db.prepare(
      'INSERT INTO topics (id, name, description) VALUES (?, ?, ?)',
    ).run(id, name, description ?? '');
    return id;
  }

  /** Link a reel to a topic with a relevance score. */
  linkReelTopic(reelId: string, topicId: string, relevance: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO reel_topics (reel_id, topic_id, relevance)
      VALUES (?, ?, ?)
    `).run(reelId, topicId, relevance);

    // Update topic reel count
    this.db.prepare(`
      UPDATE topics SET reel_count = (
        SELECT COUNT(*) FROM reel_topics WHERE topic_id = ?
      ) WHERE id = ?
    `).run(topicId, topicId);
  }

  // ── Processing log ────────────────────────────────────────────────────

  /** Log a processing step for a reel. */
  logProcessingStep(
    reelId: string,
    step: string,
    status: string,
    opts?: { durationMs?: number; error?: string },
  ): void {
    this.db.prepare(`
      INSERT INTO processing_log (reel_id, step, status, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(reelId, step, status, opts?.durationMs ?? null, opts?.error ?? null);
  }

  // ── Full-text search ──────────────────────────────────────────────────

  /** Search reels using FTS5 full-text search. */
  searchReelsFTS(query: string, limit: number = 20): StoredReel[] {
    return this.db.prepare(`
      SELECT reels.* FROM reels
      JOIN reels_fts ON reels.rowid = reels_fts.rowid
      WHERE reels_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as StoredReel[];
  }

  // ── Statistics ────────────────────────────────────────────────────────

  /** Get aggregate statistics about the knowledge base. */
  getStats(): KnowledgeStats {
    const totalReels = (this.db.prepare('SELECT COUNT(*) as c FROM reels').get() as { c: number }).c;
    const totalEntities = (this.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    const totalRelationships = (this.db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number }).c;
    const totalFacts = (this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;
    const totalTopics = (this.db.prepare('SELECT COUNT(*) as c FROM topics').get() as { c: number }).c;

    const lastRow = this.db
      .prepare('SELECT created_at FROM reels ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: string } | undefined;

    const categoryRows = this.db
      .prepare('SELECT content_type, COUNT(*) as c FROM reels GROUP BY content_type')
      .all() as { content_type: string; c: number }[];

    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) as c FROM reels GROUP BY status')
      .all() as { status: string; c: number }[];

    const reelsByCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      reelsByCategory[row.content_type] = row.c;
    }

    const reelsByStatus: Record<string, number> = {};
    for (const row of statusRows) {
      reelsByStatus[row.status] = row.c;
    }

    return {
      totalReels,
      totalEntities,
      totalRelationships,
      totalFacts,
      totalTopics,
      lastIngested: lastRow?.created_at ?? null,
      reelsByCategory,
      reelsByStatus,
    };
  }

  // ── Embeddings ──────────────────────────────────────────────────────

  /** Store an embedding vector for a reel. Uses INSERT OR REPLACE. */
  storeEmbedding(reelId: string, embedding: number[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, reel_id, embedding)
      VALUES (?, ?, ?)
    `).run(uuid(), reelId, JSON.stringify(embedding));
  }

  /** Get all stored embeddings (for brute-force vector search). */
  getAllEmbeddings(): Array<{ reel_id: string; embedding: string }> {
    return this.db
      .prepare('SELECT reel_id, embedding FROM embeddings')
      .all() as Array<{ reel_id: string; embedding: string }>;
  }

  // ── Entity queries ─────────────────────────────────────────────────

  /** Search entities by name (partial match). */
  searchEntities(query: string, limit: number = 20): StoredEntity[] {
    return this.db.prepare(`
      SELECT * FROM entities
      WHERE canonical_name LIKE ? OR display_name LIKE ?
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(`%${query.toLowerCase()}%`, `%${query}%`, limit) as StoredEntity[];
  }

  /** Get an entity by exact canonical name. */
  getEntityByName(canonicalName: string): StoredEntity | undefined {
    return this.db
      .prepare('SELECT * FROM entities WHERE canonical_name = ?')
      .get(canonicalName.toLowerCase().trim()) as StoredEntity | undefined;
  }

  /** Get all relationships for a given entity (both directions). */
  getRelationshipsForEntity(entityId: string): Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    type: string;
    description: string;
    evidence_count: number;
  }> {
    return this.db.prepare(`
      SELECT * FROM relationships
      WHERE source_entity_id = ? OR target_entity_id = ?
    `).all(entityId, entityId) as Array<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
      type: string;
      description: string;
      evidence_count: number;
    }>;
  }

  /** Get top topics sorted by reel_count descending. */
  getTopTopics(limit: number = 20): Array<{
    id: string;
    name: string;
    description: string;
    reel_count: number;
  }> {
    return this.db.prepare(`
      SELECT id, name, description, reel_count FROM topics
      ORDER BY reel_count DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      name: string;
      description: string;
      reel_count: number;
    }>;
  }

  /** Get entities of a specific type. */
  getEntitiesByType(type: string, limit: number = 20): StoredEntity[] {
    return this.db.prepare(`
      SELECT * FROM entities
      WHERE type = ?
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(type, limit) as StoredEntity[];
  }

  /** Get entities with the most mentions in recent days. */
  getTrendingEntities(
    sinceDays: number,
    limit: number = 20,
  ): Array<{
    id: string;
    canonical_name: string;
    display_name: string;
    type: string;
    mention_count: number;
    recent_mentions: number;
  }> {
    return this.db.prepare(`
      SELECT
        e.id, e.canonical_name, e.display_name, e.type, e.mention_count,
        COUNT(re.reel_id) AS recent_mentions
      FROM entities e
      JOIN reel_entities re ON re.entity_id = e.id
      JOIN reels r ON r.id = re.reel_id
      WHERE r.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY e.id
      ORDER BY recent_mentions DESC, e.mention_count DESC
      LIMIT ?
    `).all(sinceDays, limit) as Array<{
      id: string;
      canonical_name: string;
      display_name: string;
      type: string;
      mention_count: number;
      recent_mentions: number;
    }>;
  }

  /** Get a reel by its ID. */
  getReelById(id: string): StoredReel | undefined {
    return this.db
      .prepare('SELECT * FROM reels WHERE id = ?')
      .get(id) as StoredReel | undefined;
  }

  /** Get facts for a specific reel. */
  getFactsForReel(reelId: string): Array<{
    id: string;
    claim: string;
    confidence: number;
    source: string;
  }> {
    return this.db.prepare(`
      SELECT id, claim, confidence, source FROM facts
      WHERE reel_id = ?
      ORDER BY confidence DESC
    `).all(reelId) as Array<{
      id: string;
      claim: string;
      confidence: number;
      source: string;
    }>;
  }

  /** Get entities linked to a specific reel. */
  getEntitiesForReel(reelId: string): StoredEntity[] {
    return this.db.prepare(`
      SELECT e.* FROM entities e
      JOIN reel_entities re ON re.entity_id = e.id
      WHERE re.reel_id = ?
      ORDER BY e.mention_count DESC
    `).all(reelId) as StoredEntity[];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
