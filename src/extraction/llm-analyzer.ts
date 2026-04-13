import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AnalysisInput,
  ExtractedKnowledge,
  ContentType,
  EntityType,
  RelationshipType,
  Sentiment,
  HypeLevel,
  ImplementationReadiness,
  SourceType,
} from '../types.js';

const execFileAsync = promisify(execFile);

// ── Valid enum values for runtime validation ──────────────────────────────

const VALID_CONTENT_TYPES: ContentType[] = [
  'repo_recommendation', 'tutorial', 'news_update', 'tool_review',
  'research_insight', 'workflow_tip', 'product_idea', 'engineering_trick',
  'ai_technique', 'general',
];

const VALID_ENTITY_TYPES: EntityType[] = [
  'repository', 'tool', 'model', 'library', 'framework', 'paper',
  'company', 'person', 'technique', 'workflow', 'architecture',
  'product_idea', 'benchmark', 'trend',
];

const VALID_RELATIONSHIP_TYPES: RelationshipType[] = [
  'mentions', 'recommends', 'improves', 'replaces', 'integrates_with',
  'depends_on', 'similar_to', 'relevant_for', 'good_for', 'not_good_for',
  'announced_by', 'compared_against', 'used_in',
];

const VALID_SENTIMENTS: Sentiment[] = ['positive', 'negative', 'neutral', 'mixed'];

const VALID_HYPE_LEVELS: HypeLevel[] = ['grounded', 'moderate_hype', 'high_hype'];

const VALID_READINESS: ImplementationReadiness[] = [
  'production', 'beta', 'alpha', 'research', 'concept',
];

// ── OpenClaw helper ───────────────────────────────────────────────────────

async function callOpenClaw(message: string, sessionId: string): Promise<string> {
  const { stdout } = await execFileAsync('openclaw', [
    'agent',
    '--session-id', sessionId,
    '-m', message,
    '--json',
  ], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });

  const result = JSON.parse(stdout);
  if (result.status !== 'ok') {
    throw new Error(`OpenClaw agent failed: ${result.summary || 'unknown error'}`);
  }

  const text = result.result?.payloads?.[0]?.text;
  if (!text) throw new Error('No text in OpenClaw response');
  return text;
}

// ── JSON extraction ───────────────────────────────────────────────────────

/**
 * Robustly extract a JSON object from LLM text response.
 * Handles markdown code fences, leading/trailing text, etc.
 */
export function extractJsonFromText(text: string): unknown {
  let jsonStr = text;

  // Try to extract from markdown code fence first
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try direct parse
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Try to find a JSON object in the text
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // Try progressive truncation for trailing garbage
        let candidate = objectMatch[0];
        for (let i = 0; i < 5; i++) {
          const lastBrace = candidate.lastIndexOf('}');
          if (lastBrace === -1) break;
          candidate = candidate.slice(0, lastBrace + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            candidate = candidate.slice(0, lastBrace);
          }
        }
      }
    }
  }

  throw new Error('Could not extract valid JSON from LLM response');
}

// ── Source type labels for prompts ────────────────────────────────────────

/**
 * Human-readable label for each video source type, used in analysis prompts.
 */
function getVideoSourceLabel(sourceType?: SourceType): string {
  switch (sourceType) {
    case 'instagram_reel': return 'an Instagram reel';
    case 'youtube':        return 'a YouTube video';
    case 'tiktok':         return 'a TikTok video';
    default:               return 'a video';
  }
}

// ── Analysis prompt ───────────────────────────────────────────────────────

/**
 * Build an analysis prompt for video content. The prompt is tailored
 * to the source type (Instagram reel, YouTube video, TikTok, etc.)
 * while maintaining the same JSON output schema.
 *
 * @param input - Analysis input (caption, transcript, OCR, metadata)
 * @param sourceType - Optional source type for tailored prompts.
 *                     Defaults to Instagram reel for backwards compatibility.
 */
function buildAnalysisPrompt(input: AnalysisInput, sourceType?: SourceType): string {
  const sourceLabel = getVideoSourceLabel(sourceType);

  const ocrSection = input.ocrTexts.length > 0
    ? `ON-SCREEN TEXT (from OCR):\n${input.ocrTexts.map((t, i) => `[Frame ${i + 1}] ${t}`).join('\n')}`
    : 'ON-SCREEN TEXT: (none detected)';

  return `You are a knowledge extraction engine analyzing ${sourceLabel} about technology/AI/software.

METADATA:
- Author: ${input.metadata.author} (@${input.metadata.authorId})
- Title: ${input.metadata.title}
- Duration: ${input.metadata.duration}s
- Views: ${input.metadata.viewCount} | Likes: ${input.metadata.likeCount} | Comments: ${input.metadata.commentCount}
- Upload Date: ${input.metadata.uploadDate}
- Hashtags: ${input.metadata.hashtags.join(', ') || '(none)'}

CAPTION/DESCRIPTION:
${input.caption || '(empty)'}

TRANSCRIPT:
${input.transcript || '(no transcript available)'}

${ocrSection}

---

Analyze this content and extract structured knowledge. Respond with a single JSON object (no markdown fences, no extra text) with EXACTLY these fields:

{
  "summary": "2-3 sentence summary of the core knowledge in this ${sourceLabel}",

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
      "claim": "A specific factual claim made in the content",
      "confidence": 0.9,
      "source": "transcript or caption or ocr"
    }
  ],

  "actionItems": ["Things the viewer should try, install, or explore"],

  "githubUrls": ["any GitHub URLs mentioned or shown"],

  "sentiment": "one of: positive, negative, neutral, mixed - the creator's overall sentiment toward the topic",

  "hypeLevel": "one of: grounded (factual/measured), moderate_hype (enthusiastic but reasonable), high_hype (strong promotion, possibly overstated)",

  "implementationReadiness": "one of: production (stable, widely used), beta (usable but evolving), alpha (early stage), research (academic/experimental), concept (idea only)",

  "tags": ["lowercase_tag1", "lowercase_tag2"]
}

RULES:
- Extract ALL entities mentioned (tools, repos, models, people, companies, techniques, etc.)
- Create relationships between entities where the content implies connections
- For facts, only include specific claims (not opinions) with confidence 0.0 to 1.0
- For githubUrls, extract any GitHub links from transcript, caption, or OCR text
- Tags should be lowercase, using underscores for spaces
- Be thorough -- this data feeds a personal knowledge graph
- If the content is not tech-related, still extract what you can and use contentType "general"`;
}

// ── Validation & defaults ─────────────────────────────────────────────────

function validateAndClean(raw: Record<string, unknown>): ExtractedKnowledge {
  const asString = (v: unknown, fallback: string): string =>
    typeof v === 'string' ? v : fallback;

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const asNumber = (v: unknown, fallback: number): number =>
    typeof v === 'number' ? v : fallback;

  return {
    summary: asString(raw.summary, 'No summary available'),

    topics: asStringArray(raw.topics),

    contentType: VALID_CONTENT_TYPES.includes(raw.contentType as ContentType)
      ? (raw.contentType as ContentType)
      : 'general',

    entities: Array.isArray(raw.entities)
      ? raw.entities.map((e: Record<string, unknown>) => ({
          name: asString(e.name, 'Unknown'),
          type: VALID_ENTITY_TYPES.includes(e.type as EntityType)
            ? (e.type as EntityType)
            : 'tool',
          description: asString(e.description, ''),
          ...(Array.isArray(e.aliases) ? { aliases: asStringArray(e.aliases) } : {}),
        }))
      : [],

    relationships: Array.isArray(raw.relationships)
      ? raw.relationships.map((r: Record<string, unknown>) => ({
          source: asString(r.source, ''),
          target: asString(r.target, ''),
          type: VALID_RELATIONSHIP_TYPES.includes(r.type as RelationshipType)
            ? (r.type as RelationshipType)
            : 'mentions',
          description: asString(r.description, ''),
        }))
      : [],

    facts: Array.isArray(raw.facts)
      ? raw.facts.map((f: Record<string, unknown>) => ({
          claim: asString(f.claim, ''),
          confidence: Math.max(0, Math.min(1, asNumber(f.confidence, 0.5))),
          source: (['transcript', 'caption', 'ocr'].includes(f.source as string)
            ? f.source
            : 'transcript') as 'transcript' | 'caption' | 'ocr',
        }))
      : [],

    actionItems: asStringArray(raw.actionItems),

    githubUrls: asStringArray(raw.githubUrls),

    sentiment: VALID_SENTIMENTS.includes(raw.sentiment as Sentiment)
      ? (raw.sentiment as Sentiment)
      : 'neutral',

    hypeLevel: VALID_HYPE_LEVELS.includes(raw.hypeLevel as HypeLevel)
      ? (raw.hypeLevel as HypeLevel)
      : 'grounded',

    implementationReadiness: VALID_READINESS.includes(raw.implementationReadiness as ImplementationReadiness)
      ? (raw.implementationReadiness as ImplementationReadiness)
      : 'concept',

    tags: asStringArray(raw.tags).map(t => t.toLowerCase().replace(/\s+/g, '_')),
  };
}

// ── Main exports ──────────────────────────────────────────────────────────

/**
 * Analyze video content using an LLM via OpenClaw CLI.
 * Sends caption, transcript, OCR text, and metadata to the LLM and
 * returns structured knowledge extraction.
 *
 * @param input - Analysis input data (caption, transcript, OCR, metadata)
 * @param sessionPrefix - Prefix for the OpenClaw session ID
 * @param sourceType - Optional source type for tailored prompts.
 *                     Defaults to 'instagram_reel' for backwards compatibility.
 */
export async function analyzeContent(
  input: AnalysisInput,
  sessionPrefix: string,
  sourceType?: SourceType,
): Promise<ExtractedKnowledge> {
  const sessionId = `${sessionPrefix}-analyze-${Date.now()}`;
  const prompt = buildAnalysisPrompt(input, sourceType);

  const response = await callOpenClaw(prompt, sessionId);
  const parsed = extractJsonFromText(response) as Record<string, unknown>;

  return validateAndClean(parsed);
}

/**
 * Analyze content using a custom prompt string.
 *
 * This is used by the GitHub, web, arXiv, and plain text extractors
 * which build their own specialized prompts. The function handles
 * the OpenClaw call, JSON extraction, and validation/cleaning.
 *
 * @param prompt - The full analysis prompt to send to the LLM
 * @param sessionId - OpenClaw session ID for this analysis
 */
export async function analyzeWithPrompt(
  prompt: string,
  sessionId: string,
): Promise<ExtractedKnowledge> {
  const response = await callOpenClaw(prompt, sessionId);
  const parsed = extractJsonFromText(response) as Record<string, unknown>;
  return validateAndClean(parsed);
}
