// ── Web Page Extractor ────────────────────────────────────────────────────
//
// Extracts knowledge from web pages: Reddit posts, Hacker News threads,
// articles, blog posts, and any other HTTP(S) page.
//
// Uses platform-specific strategies where available:
// - Reddit: JSON API at {url}.json
// - Hacker News: Firebase API at hacker-news.firebaseio.com
// - Everything else: curl + HTML-to-text stripping

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SourceType } from '../ingestion/url-router.js';
import type { ExtractedKnowledge } from '../types.js';
import { analyzeWithPrompt } from './llm-analyzer.js';

const execFileAsync = promisify(execFile);

// ── Web page data interface ──────────────────────────────────────────────

export interface WebPageData {
  url: string;
  title: string;
  author: string;
  content: string;
  publishDate: string;
  siteName: string;
  description: string;
}

// ── HTML stripping helpers ───────────────────────────────────────────────

/**
 * Strip HTML tags from a string and normalize whitespace.
 * This is a simple approach -- not a full HTML parser.
 */
function stripHtml(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Convert <br>, <p>, <div>, <li> to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6]|tr|blockquote)[\s>]/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract page title from HTML <title> tag.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

/**
 * Extract meta tag content by name or property.
 */
function extractMeta(html: string, attr: string): string {
  // Try name="attr"
  const nameMatch = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${attr}["'][^>]+content=["']([^"']+)["']`, 'i'),
  );
  if (nameMatch) return nameMatch[1].trim();

  // Try content before name (some pages reverse the order)
  const reverseMatch = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${attr}["']`, 'i'),
  );
  if (reverseMatch) return reverseMatch[1].trim();

  return '';
}

/**
 * Extract the main article content from HTML.
 * Tries <article> tag first, then <main>, then falls back to <body>.
 */
function extractArticleContent(html: string): string {
  // Try <article> tag
  const articleMatch = html.match(/<article[\s>][\s\S]*?<\/article>/i);
  if (articleMatch) return stripHtml(articleMatch[0]);

  // Try <main> tag
  const mainMatch = html.match(/<main[\s>][\s\S]*?<\/main>/i);
  if (mainMatch) return stripHtml(mainMatch[0]);

  // Try role="main"
  const roleMatch = html.match(/<[^>]+role=["']main["'][\s>][\s\S]*?<\/[^>]+>/i);
  if (roleMatch) return stripHtml(roleMatch[0]);

  // Fallback: strip entire body
  const bodyMatch = html.match(/<body[\s>][\s\S]*?<\/body>/i);
  if (bodyMatch) return stripHtml(bodyMatch[0]);

  return stripHtml(html);
}

// ── Fetch helpers ────────────────────────────────────────────────────────

/**
 * Fetch a URL using curl and return the raw response body.
 */
async function fetchUrl(url: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sL',                          // silent + follow redirects
      '--max-time', '30',             // timeout
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      url,
    ],
    { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Fetch JSON from a URL using curl.
 */
async function fetchJson(url: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sL',
      '--max-time', '30',
      '-H', 'User-Agent: Mozilla/5.0 (compatible; KnowledgeEngine/1.0)',
      '-H', 'Accept: application/json',
      url,
    ],
    { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

// ── Platform-specific extractors ─────────────────────────────────────────

/**
 * Extract content from a Reddit post using the JSON API.
 * Reddit provides a JSON version of any page at {url}.json
 */
async function extractRedditPost(url: string): Promise<WebPageData> {
  // Normalize URL and append .json
  const cleanUrl = url.replace(/\/?(\?.*)?$/, '');
  const jsonUrl = `${cleanUrl}.json`;

  try {
    const data = await fetchJson(jsonUrl) as Array<{ data: { children: Array<{ data: Record<string, unknown> }> } }>;

    // Reddit JSON structure: array of listings, first is the post, second is comments
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) {
      throw new Error('Could not parse Reddit JSON response');
    }

    const selftext = (post.selftext as string) || '';
    const title = (post.title as string) || '';

    // Collect top-level comments for context
    const comments: string[] = [];
    const commentChildren = data?.[1]?.data?.children || [];
    for (const child of commentChildren.slice(0, 10)) {
      const body = child?.data?.body as string;
      if (body && typeof body === 'string') {
        comments.push(body);
      }
    }

    const commentText = comments.length > 0
      ? '\n\n--- TOP COMMENTS ---\n' + comments.join('\n---\n')
      : '';

    return {
      url,
      title,
      author: (post.author as string) || '',
      content: (selftext + commentText).slice(0, 8000),
      publishDate: post.created_utc
        ? new Date((post.created_utc as number) * 1000).toISOString()
        : '',
      siteName: `r/${(post.subreddit as string) || 'unknown'}`,
      description: title,
    };
  } catch {
    // Fallback to generic HTML extraction
    console.warn('[web-extractor] Reddit JSON API failed, falling back to HTML extraction');
    return extractGenericPage(url);
  }
}

/**
 * Extract content from a Hacker News thread using the Firebase API.
 */
async function extractHackerNews(itemId: string): Promise<WebPageData> {
  const apiUrl = `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`;

  try {
    const item = await fetchJson(apiUrl) as Record<string, unknown>;

    if (!item || !item.id) {
      throw new Error('Invalid HN API response');
    }

    const title = (item.title as string) || '';
    const text = (item.text as string) || '';
    const itemUrl = (item.url as string) || '';

    // Fetch top-level comments (kids)
    const kids = (item.kids as number[]) || [];
    const commentTexts: string[] = [];

    // Fetch up to 10 top-level comments
    for (const kidId of kids.slice(0, 10)) {
      try {
        const comment = await fetchJson(
          `https://hacker-news.firebaseio.com/v0/item/${kidId}.json`,
        ) as Record<string, unknown>;
        if (comment?.text && !comment.deleted && !comment.dead) {
          commentTexts.push(stripHtml(comment.text as string));
        }
      } catch {
        // Skip failed comment fetches
      }
    }

    const commentSection = commentTexts.length > 0
      ? '\n\n--- TOP COMMENTS ---\n' + commentTexts.join('\n---\n')
      : '';

    // If HN item links to an external URL, mention it
    const linkNote = itemUrl ? `\nLinked URL: ${itemUrl}` : '';

    return {
      url: `https://news.ycombinator.com/item?id=${itemId}`,
      title,
      author: (item.by as string) || '',
      content: (stripHtml(text) + linkNote + commentSection).slice(0, 8000),
      publishDate: item.time
        ? new Date((item.time as number) * 1000).toISOString()
        : '',
      siteName: 'Hacker News',
      description: title,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[web-extractor] HN API failed: ${msg}`);
    // Fallback to generic
    return extractGenericPage(`https://news.ycombinator.com/item?id=${itemId}`);
  }
}

/**
 * Extract content from a generic web page using curl + HTML stripping.
 */
async function extractGenericPage(url: string): Promise<WebPageData> {
  const html = await fetchUrl(url);

  const title = extractTitle(html);
  const content = extractArticleContent(html);
  const author = extractMeta(html, 'author') || extractMeta(html, 'article:author');
  const publishDate = extractMeta(html, 'article:published_time')
    || extractMeta(html, 'date')
    || extractMeta(html, 'pubdate');
  const siteName = extractMeta(html, 'og:site_name');
  const description = extractMeta(html, 'og:description')
    || extractMeta(html, 'description');

  return {
    url,
    title,
    author,
    content: content.slice(0, 8000), // Cap content length for LLM context
    publishDate,
    siteName,
    description,
  };
}

// ── Main extraction function ─────────────────────────────────────────────

/**
 * Extract content from a web page. Routes to the appropriate
 * platform-specific extractor based on the source type.
 *
 * @param url - The URL to extract content from
 * @param sourceType - Optional source type hint for platform-specific extraction
 * @param identifier - Optional platform-specific identifier (e.g., HN item ID)
 */
export async function extractWebPage(
  url: string,
  sourceType?: SourceType,
  identifier?: string,
): Promise<WebPageData> {
  switch (sourceType) {
    case 'reddit_post':
      return extractRedditPost(url);

    case 'hacker_news':
      if (identifier) {
        return extractHackerNews(identifier);
      }
      // Try to extract item ID from URL
      const hnMatch = url.match(/[?&]id=(\d+)/);
      if (hnMatch) {
        return extractHackerNews(hnMatch[1]);
      }
      return extractGenericPage(url);

    default:
      return extractGenericPage(url);
  }
}

// ── LLM Analysis ─────────────────────────────────────────────────────────

/**
 * Build a web-page-specific analysis prompt based on source type.
 */
function buildWebPagePrompt(data: WebPageData, sourceType: SourceType): string {
  const SOURCE_LABELS: Record<string, string> = {
    reddit_post: 'a Reddit post',
    hacker_news: 'a Hacker News discussion',
    twitter_post: 'a Twitter/X post',
    github_issue: 'a GitHub issue',
    github_pr: 'a GitHub pull request',
    article: 'a web article',
    plain_text: 'a text note',
  };
  const sourceLabel = SOURCE_LABELS[sourceType] || 'a web page';

  return `You are a knowledge extraction engine analyzing ${sourceLabel} about technology/AI/software.

PAGE METADATA:
- URL: ${data.url}
- Title: ${data.title || '(untitled)'}
- Author: ${data.author || '(unknown)'}
- Site: ${data.siteName || '(unknown)'}
- Published: ${data.publishDate || '(unknown)'}
- Description: ${data.description || '(none)'}

CONTENT:
${data.content || '(no content extracted)'}

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
      "source": "caption"
    }
  ],

  "actionItems": ["Things the reader should try, install, or explore"],

  "githubUrls": ["any GitHub URLs mentioned in the content"],

  "sentiment": "one of: positive, negative, neutral, mixed",

  "hypeLevel": "one of: grounded (factual/measured), moderate_hype (enthusiastic but reasonable), high_hype (strong promotion, possibly overstated)",

  "implementationReadiness": "one of: production (stable, widely used), beta (usable but evolving), alpha (early stage), research (academic/experimental), concept (idea only)",

  "tags": ["lowercase_tag1", "lowercase_tag2"]
}

RULES:
- Extract ALL entities mentioned (tools, repos, models, people, companies, techniques, etc.)
- Create relationships between entities where the content implies connections
- For facts, only include specific claims (not opinions) with confidence 0.0 to 1.0
- For githubUrls, extract any GitHub links mentioned in the text
- Tags should be lowercase, using underscores for spaces
- Be thorough -- this data feeds a personal knowledge graph
- If the content is not tech-related, still extract what you can and use contentType "general"
- For Reddit/HN discussions, pay special attention to recommendations and opinions in comments`;
}

/**
 * Analyze web page content using the OpenClaw LLM.
 * Builds a source-type-specific prompt and returns structured knowledge.
 */
export async function analyzeWebPage(
  data: WebPageData,
  sourceType: SourceType,
): Promise<ExtractedKnowledge> {
  const prompt = buildWebPagePrompt(data, sourceType);
  const sessionId = `ke-web-${sourceType}-${Date.now()}`;

  return analyzeWithPrompt(prompt, sessionId);
}
