// ── Unified Ingestion Pipeline ────────────────────────────────────────────
//
// Single entry point for ingesting ANY content type into the Knowledge Engine.
// Routes to the appropriate extractor based on source type:
//
// - Video content (Instagram, YouTube, TikTok) → video pipeline
// - GitHub repos → GitHub extractor
// - GitHub issues/PRs → web extractor
// - Reddit, HN, articles → web extractor
// - Twitter/X → web extractor
// - arXiv papers → arXiv extractor
// - Plain text → direct LLM analysis

import type { SourceType } from '../ingestion/url-router.js';
import type { PipelineConfig, ExtractedKnowledge } from '../types.js';
import { extractFromVideo } from './video-pipeline.js';
import { extractGitHubRepo, analyzeGitHubRepo } from './github-extractor.js';
import { extractWebPage, analyzeWebPage } from './web-extractor.js';
import { extractArxivPaper, analyzeArxivPaper } from './arxiv-extractor.js';
import { analyzeWithPrompt } from './llm-analyzer.js';

// ── Unified result type ──────────────────────────────────────────────────

export interface UnifiedResult {
  /** Classified source type */
  sourceType: SourceType;
  /** Canonical URL (empty string for plain_text) */
  url: string;
  /** Platform-specific identifier */
  identifier: string;
  /** Platform-specific metadata (varies by source type) */
  metadata: Record<string, unknown>;
  /** Transcript from audio (video content only) */
  transcript?: string;
  /** OCR text from video frames (video content only) */
  ocrTexts?: string[];
  /** Extracted and structured knowledge */
  knowledge: ExtractedKnowledge;
  /** Total processing time in milliseconds */
  processingTimeMs: number;
}

// ── Logging helper ───────────────────────────────────────────────────────

function log(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] unified: ${step}: ${msg}`);
}

// ── Video source types ───────────────────────────────────────────────────

const VIDEO_SOURCE_TYPES: SourceType[] = [
  'instagram_reel',
  'youtube',
  'tiktok',
];

// ── Plain text analysis ──────────────────────────────────────────────────

/**
 * Build a prompt for analyzing plain text notes/messages.
 */
function buildPlainTextPrompt(text: string): string {
  return `You are a knowledge extraction engine analyzing a plain text note or message about technology/AI/software.

TEXT:
${text.slice(0, 8000)}

---

Analyze this text and extract structured knowledge. Respond with a single JSON object (no markdown fences, no extra text) with EXACTLY these fields:

{
  "summary": "2-3 sentence summary of the core knowledge in this text",

  "topics": ["topic1", "topic2"],

  "contentType": "one of: repo_recommendation, tutorial, news_update, tool_review, research_insight, workflow_tip, product_idea, engineering_trick, ai_technique, general",

  "entities": [
    {
      "name": "Display Name",
      "type": "one of: repository, tool, model, library, framework, paper, company, person, technique, workflow, architecture, product_idea, benchmark, trend",
      "description": "Brief description of this entity and its relevance",
      "aliases": ["alternative names or abbreviations"]
    }
  ],

  "relationships": [
    {
      "source": "Entity Name A",
      "target": "Entity Name B",
      "type": "one of: mentions, recommends, improves, replaces, integrates_with, depends_on, similar_to, relevant_for, good_for, not_good_for, announced_by, compared_against, used_in",
      "description": "How these entities are related"
    }
  ],

  "facts": [
    {
      "claim": "A specific factual claim made in the text",
      "confidence": 0.9,
      "source": "caption"
    }
  ],

  "actionItems": ["Things to try, install, or explore"],

  "githubUrls": ["any GitHub URLs mentioned"],

  "sentiment": "one of: positive, negative, neutral, mixed",

  "hypeLevel": "one of: grounded (factual/measured), moderate_hype (enthusiastic but reasonable), high_hype (strong promotion, possibly overstated)",

  "implementationReadiness": "one of: production (stable, widely used), beta (usable but evolving), alpha (early stage), research (academic/experimental), concept (idea only)",

  "tags": ["lowercase_tag1", "lowercase_tag2"]
}

RULES:
- Extract ALL entities mentioned (tools, repos, models, people, companies, techniques, etc.)
- Create relationships between entities where the text implies connections
- For facts, only include specific claims (not opinions) with confidence 0.0 to 1.0
- Tags should be lowercase, using underscores for spaces
- Be thorough -- this data feeds a personal knowledge graph
- If the content is not tech-related, still extract what you can and use contentType "general"`;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Ingest content from any source type. Routes to the appropriate
 * extractor and returns a UnifiedResult.
 *
 * @param url - The URL to ingest (empty string for plain_text)
 * @param sourceType - The classified source type
 * @param identifier - Platform-specific identifier
 * @param config - Pipeline configuration (media dir, whisper model, etc.)
 * @param rawText - Original message text (used for plain_text source type)
 */
export async function ingestContent(
  url: string,
  sourceType: SourceType,
  identifier: string,
  config: PipelineConfig,
  rawText?: string,
): Promise<UnifiedResult> {
  const startTime = Date.now();
  log('start', `Ingesting ${sourceType}: ${url || '(plain text)'}`);

  // ── Video content ────────────────────────────────────────────────────
  if (VIDEO_SOURCE_TYPES.includes(sourceType)) {
    log('route', `Routing to video pipeline for ${sourceType}`);
    const result = await extractFromVideo(url, sourceType, config);

    return {
      sourceType,
      url: result.url,
      identifier: result.shortcode,
      metadata: result.metadata as unknown as Record<string, unknown>,
      transcript: result.transcript,
      ocrTexts: result.ocrTexts,
      knowledge: result.knowledge,
      processingTimeMs: Date.now() - startTime,
    };
  }

  // ── GitHub repository ────────────────────────────────────────────────
  if (sourceType === 'github_repo') {
    log('route', 'Routing to GitHub extractor');
    const [owner, repo] = identifier.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub identifier: ${identifier}`);
    }

    const repoData = await extractGitHubRepo(owner, repo);
    log('extract', `Fetched ${repoData.fullName} (${repoData.stars} stars)`);

    const knowledge = await analyzeGitHubRepo(repoData);
    log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

    return {
      sourceType,
      url,
      identifier,
      metadata: repoData as unknown as Record<string, unknown>,
      knowledge,
      processingTimeMs: Date.now() - startTime,
    };
  }

  // ── arXiv paper ──────────────────────────────────────────────────────
  if (sourceType === 'arxiv_paper') {
    log('route', 'Routing to arXiv extractor');

    const paperData = await extractArxivPaper(identifier);
    log('extract', `Fetched "${paperData.title}" by ${paperData.authors.length} author(s)`);

    const knowledge = await analyzeArxivPaper(paperData);
    log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

    return {
      sourceType,
      url,
      identifier,
      metadata: paperData as unknown as Record<string, unknown>,
      knowledge,
      processingTimeMs: Date.now() - startTime,
    };
  }

  // ── Plain text ───────────────────────────────────────────────────────
  if (sourceType === 'plain_text') {
    log('route', 'Routing to plain text analyzer');
    const text = rawText || '';

    if (text.trim().length === 0) {
      throw new Error('No text provided for plain_text source type');
    }

    const prompt = buildPlainTextPrompt(text);
    const sessionId = `ke-plaintext-${Date.now()}`;
    const knowledge = await analyzeWithPrompt(prompt, sessionId);
    log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

    return {
      sourceType,
      url: '',
      identifier,
      metadata: { rawText: text.slice(0, 1000) },
      knowledge,
      processingTimeMs: Date.now() - startTime,
    };
  }

  // ── Web content (Reddit, HN, Twitter, GitHub issues/PRs, articles) ──
  log('route', `Routing to web extractor for ${sourceType}`);

  const pageData = await extractWebPage(url, sourceType, identifier);
  log('extract', `Fetched "${pageData.title || '(untitled)'}" from ${pageData.siteName || pageData.url}`);

  const knowledge = await analyzeWebPage(pageData, sourceType);
  log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

  return {
    sourceType,
    url,
    identifier,
    metadata: pageData as unknown as Record<string, unknown>,
    knowledge,
    processingTimeMs: Date.now() - startTime,
  };
}
