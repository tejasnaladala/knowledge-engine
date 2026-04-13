import { v4 as uuid } from 'uuid';
import type { KnowledgeDB } from './db.js';
import type { ExtractionResult, SourceType } from '../types.js';
import type { UnifiedResult } from '../extraction/unified-pipeline.js';

/**
 * Store a full extraction result in the knowledge database.
 *
 * Takes the output from the extraction pipeline and:
 * 1. Creates/updates the reel record
 * 2. Upserts all entities
 * 3. Links entities to the reel
 * 4. Creates relationships between entities
 * 5. Stores extracted facts
 * 6. Adds tags
 * 7. Creates and links topics
 *
 * Returns the stored reel ID.
 */
export function storeExtractionResult(
  db: KnowledgeDB,
  result: ExtractionResult,
): string {
  const reelId = uuid();
  const { knowledge, metadata } = result;

  // 1. Insert the reel record
  db.insertReel({
    id: reelId,
    url: result.url,
    shortcode: result.shortcode,
    source_type: 'instagram_reel', // Default for legacy ExtractionResult
    author: metadata.author,
    author_id: metadata.authorId,
    title: metadata.title,
    description: metadata.description,
    duration: metadata.duration,
    view_count: metadata.viewCount,
    like_count: metadata.likeCount,
    comment_count: metadata.commentCount,
    upload_date: metadata.uploadDate,
    thumbnail_url: metadata.thumbnailUrl,
    transcript: result.transcript,
    ocr_text: result.ocrTexts.join('\n---\n'),
    summary: knowledge.summary,
    content_type: knowledge.contentType,
    sentiment: knowledge.sentiment,
    hype_level: knowledge.hypeLevel,
    implementation_readiness: knowledge.implementationReadiness,
    github_urls: JSON.stringify(knowledge.githubUrls),
    action_items: JSON.stringify(knowledge.actionItems),
    status: 'complete',
  });

  // Store entities, relationships, facts, tags, and topics
  storeKnowledgeGraph(db, reelId, knowledge, metadata.hashtags, result.processingTimeMs);

  return reelId;
}

/**
 * Store a unified result (from any content type) in the knowledge database.
 *
 * This is the new universal storage function that handles all source types.
 * It accepts the UnifiedResult from the unified pipeline and stores it
 * with proper source_type metadata.
 *
 * Returns the stored reel ID.
 */
export function storeUnifiedResult(
  db: KnowledgeDB,
  result: UnifiedResult,
): string {
  const reelId = uuid();
  const { knowledge, metadata } = result;

  // Extract metadata fields with safe defaults
  // These may come from different extractor shapes (video metadata, web page data, etc.)
  const author = asStr(metadata.author) || asStr(metadata.owner) || '';
  const authorId = asStr(metadata.authorId) || asStr(metadata.author_id) || asStr(metadata.owner) || '';
  const title = asStr(metadata.title) || asStr(metadata.fullName) || '';
  const description = asStr(metadata.description) || asStr(metadata.abstract) || '';
  const duration = asNum(metadata.duration);
  const viewCount = asNum(metadata.viewCount) || asNum(metadata.view_count) || asNum(metadata.stars);
  const likeCount = asNum(metadata.likeCount) || asNum(metadata.like_count);
  const commentCount = asNum(metadata.commentCount) || asNum(metadata.comment_count) || asNum(metadata.openIssues);
  const uploadDate = asStr(metadata.uploadDate) || asStr(metadata.upload_date)
    || asStr(metadata.publishDate) || asStr(metadata.createdAt) || '';
  const thumbnailUrl = asStr(metadata.thumbnailUrl) || asStr(metadata.thumbnail_url)
    || asStr(metadata.pdfUrl) || '';

  // Extract hashtags if present (video content)
  const hashtags: string[] = Array.isArray(metadata.hashtags)
    ? (metadata.hashtags as string[])
    : [];

  // 1. Insert the reel record
  db.insertReel({
    id: reelId,
    url: result.url || '',
    shortcode: result.identifier,
    source_type: result.sourceType,
    author,
    author_id: authorId,
    title,
    description,
    duration,
    view_count: viewCount,
    like_count: likeCount,
    comment_count: commentCount,
    upload_date: uploadDate,
    thumbnail_url: thumbnailUrl,
    transcript: result.transcript || '',
    ocr_text: result.ocrTexts?.join('\n---\n') || '',
    summary: knowledge.summary,
    content_type: knowledge.contentType,
    sentiment: knowledge.sentiment,
    hype_level: knowledge.hypeLevel,
    implementation_readiness: knowledge.implementationReadiness,
    github_urls: JSON.stringify(knowledge.githubUrls),
    action_items: JSON.stringify(knowledge.actionItems),
    status: 'complete',
  });

  // Store entities, relationships, facts, tags, and topics
  storeKnowledgeGraph(db, reelId, knowledge, hashtags, result.processingTimeMs);

  return reelId;
}

// ── Shared knowledge graph storage ───────────────────────────────────────

/**
 * Store the knowledge graph components (entities, relationships, facts,
 * tags, topics) for a given reel. Used by both storeExtractionResult
 * and storeUnifiedResult.
 */
function storeKnowledgeGraph(
  db: KnowledgeDB,
  reelId: string,
  knowledge: ExtractionResult['knowledge'],
  hashtags: string[],
  processingTimeMs: number,
): void {
  // 2. Upsert entities and build name -> ID map
  const entityIdMap = new Map<string, string>();

  for (const entity of knowledge.entities) {
    const entityId = db.upsertEntity({
      name: entity.name,
      type: entity.type,
      description: entity.description,
      aliases: entity.aliases,
    });
    entityIdMap.set(entity.name, entityId);

    // 3. Link entity to reel
    db.linkReelEntity(reelId, entityId, entity.description, 1.0, 'analysis');
  }

  // 4. Create relationships between entities
  for (const rel of knowledge.relationships) {
    const sourceId = entityIdMap.get(rel.source);
    const targetId = entityIdMap.get(rel.target);

    if (sourceId && targetId) {
      db.upsertRelationship(sourceId, targetId, rel.type, rel.description);
    }
  }

  // 5. Store facts
  for (const fact of knowledge.facts) {
    db.insertFact({
      reelId,
      claim: fact.claim,
      confidence: fact.confidence,
      source: fact.source,
    });
  }

  // 6. Add tags
  if (knowledge.tags.length > 0) {
    db.addReelTags(reelId, knowledge.tags);
  }

  // Also add hashtags from metadata as tags
  if (hashtags.length > 0) {
    db.addReelTags(
      reelId,
      hashtags.map(h => h.replace(/^#/, '')),
    );
  }

  // 7. Create and link topics
  for (const topicName of knowledge.topics) {
    const topicId = db.upsertTopic(topicName);
    db.linkReelTopic(reelId, topicId, 1.0);
  }

  // Log processing completion
  db.logProcessingStep(reelId, 'store', 'complete', {
    durationMs: processingTimeMs,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Safely extract a string from unknown metadata values. */
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  return '';
}

/** Safely extract a number from unknown metadata values. */
function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return 0;
}
