// ── Universal URL Router ──────────────────────────────────────────────────
//
// Detects and classifies any URL into a known source type for the
// Knowledge Engine. Handles Instagram, YouTube, TikTok, GitHub, Reddit,
// Twitter/X, Hacker News, arXiv, and generic web articles.
//
// Also handles plain text messages that contain no URLs.

// ── Source type enum ─────────────────────────────────────────────────────

export type SourceType =
  | 'instagram_reel'
  | 'youtube'
  | 'github_repo'
  | 'github_issue'
  | 'github_pr'
  | 'reddit_post'
  | 'twitter_post'
  | 'tiktok'
  | 'hacker_news'
  | 'arxiv_paper'
  | 'article'
  | 'plain_text';

// ── Detected content interface ──────────────────────────────────────────

export interface DetectedContent {
  /** Classified source type */
  sourceType: SourceType;
  /** Normalized canonical URL */
  url: string;
  /** Original URL as found in the message text */
  rawUrl: string;
  /** Platform-specific identifier (shortcode, video ID, repo slug, etc.) */
  identifier: string;
}

// ── URL patterns ─────────────────────────────────────────────────────────
//
// Each pattern is tried in order. The first match wins for classification.
// More specific patterns come before generic ones.

interface UrlPattern {
  sourceType: SourceType;
  regex: RegExp;
  /** Extract the platform-specific identifier from the match */
  extractIdentifier: (match: RegExpMatchArray) => string;
  /** Build a normalized canonical URL from the match */
  normalizeUrl: (match: RegExpMatchArray, rawUrl: string) => string;
}

const URL_PATTERNS: UrlPattern[] = [
  // ── Instagram reel/post ─────────────────────────────────────────────
  {
    sourceType: 'instagram_reel',
    regex: /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)\/?/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://www.instagram.com/reel/${m[1]}/`,
  },

  // ── YouTube Shorts ──────────────────────────────────────────────────
  {
    sourceType: 'youtube',
    regex: /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]+)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://www.youtube.com/shorts/${m[1]}`,
  },

  // ── YouTube standard watch URL ──────────────────────────────────────
  {
    sourceType: 'youtube',
    regex: /https?:\/\/(?:www\.)?youtube\.com\/watch\?.*v=([A-Za-z0-9_-]+)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://www.youtube.com/watch?v=${m[1]}`,
  },

  // ── YouTube short link (youtu.be) ───────────────────────────────────
  {
    sourceType: 'youtube',
    regex: /https?:\/\/youtu\.be\/([A-Za-z0-9_-]+)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://www.youtube.com/watch?v=${m[1]}`,
  },

  // ── TikTok ──────────────────────────────────────────────────────────
  {
    sourceType: 'tiktok',
    regex: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]+)\/video\/(\d+)/,
    extractIdentifier: (m) => m[2],
    normalizeUrl: (m) => `https://www.tiktok.com/@${m[1]}/video/${m[2]}`,
  },

  // ── TikTok short link (vm.tiktok.com) ───────────────────────────────
  {
    sourceType: 'tiktok',
    regex: /https?:\/\/vm\.tiktok\.com\/([A-Za-z0-9]+)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (_m, raw) => raw.split('?')[0],
  },

  // ── GitHub Pull Request ─────────────────────────────────────────────
  // Must come before github_repo to avoid matching /pull/ as a repo path
  {
    sourceType: 'github_pr',
    regex: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/,
    extractIdentifier: (m) => `${m[1]}/${m[2]}#${m[3]}`,
    normalizeUrl: (m) => `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
  },

  // ── GitHub Issue ────────────────────────────────────────────────────
  // Must come before github_repo to avoid matching /issues/ as a repo path
  {
    sourceType: 'github_issue',
    regex: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/,
    extractIdentifier: (m) => `${m[1]}/${m[2]}#${m[3]}`,
    normalizeUrl: (m) => `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`,
  },

  // ── GitHub Repository ───────────────────────────────────────────────
  // Only matches owner/repo, NOT sub-paths like /tree/, /blob/, /actions/, etc.
  {
    sourceType: 'github_repo',
    regex: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?(?:\?[^\s]*)?$/,
    extractIdentifier: (m) => `${m[1]}/${m[2]}`,
    normalizeUrl: (m) => `https://github.com/${m[1]}/${m[2]}`,
  },

  // ── GitHub Repository (lenient -- matches even when followed by more text) ──
  // Falls back to this if the strict regex above doesn't match, e.g. when
  // the URL is embedded mid-sentence.
  {
    sourceType: 'github_repo',
    regex: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:$|\?|#))?/,
    extractIdentifier: (m) => {
      // Exclude URLs that are actually sub-resource pages (issues, pull, actions, etc.)
      const subPaths = ['issues', 'pull', 'pulls', 'actions', 'tree', 'blob', 'commit', 'commits', 'releases', 'wiki', 'settings', 'discussions', 'projects', 'security', 'packages', 'stargazers', 'watchers', 'network', 'compare'];
      if (subPaths.includes(m[2].toLowerCase())) return '';
      return `${m[1]}/${m[2]}`;
    },
    normalizeUrl: (m) => `https://github.com/${m[1]}/${m[2]}`,
  },

  // ── Reddit post ─────────────────────────────────────────────────────
  {
    sourceType: 'reddit_post',
    regex: /https?:\/\/(?:www\.)?(?:old\.)?reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)/,
    extractIdentifier: (m) => m[2],
    normalizeUrl: (m, raw) => {
      // Keep the full URL up to the comment ID + optional slug
      const cleaned = raw.split('?')[0].split('#')[0];
      return cleaned;
    },
  },

  // ── Twitter/X post ──────────────────────────────────────────────────
  {
    sourceType: 'twitter_post',
    regex: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/,
    extractIdentifier: (m) => m[2],
    normalizeUrl: (m) => `https://x.com/${m[1]}/status/${m[2]}`,
  },

  // ── Hacker News ─────────────────────────────────────────────────────
  {
    sourceType: 'hacker_news',
    regex: /https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://news.ycombinator.com/item?id=${m[1]}`,
  },

  // ── arXiv paper (abstract page) ─────────────────────────────────────
  {
    sourceType: 'arxiv_paper',
    regex: /https?:\/\/arxiv\.org\/abs\/([0-9]+\.[0-9]+(?:v\d+)?)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://arxiv.org/abs/${m[1]}`,
  },

  // ── arXiv paper (PDF link) ──────────────────────────────────────────
  {
    sourceType: 'arxiv_paper',
    regex: /https?:\/\/arxiv\.org\/pdf\/([0-9]+\.[0-9]+(?:v\d+)?)/,
    extractIdentifier: (m) => m[1],
    normalizeUrl: (m) => `https://arxiv.org/abs/${m[1]}`,
  },
];

// ── Generic URL extraction regex ─────────────────────────────────────────
// Matches any http/https URL in text
const GENERIC_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Classify a single URL into a source type and extract its identifier.
 * Returns the source type and identifier. If the URL doesn't match any
 * known pattern, it's classified as 'article' (generic web page).
 */
export function classifyUrl(url: string): { sourceType: SourceType; identifier: string } {
  // Clean trailing punctuation that may have been captured from text
  const cleanedUrl = url.replace(/[.,;:!?)}\]]+$/, '');

  for (const pattern of URL_PATTERNS) {
    const match = cleanedUrl.match(pattern.regex);
    if (match) {
      const identifier = pattern.extractIdentifier(match);
      // Skip patterns that return empty identifiers (e.g., GitHub sub-paths)
      if (identifier === '') continue;
      return { sourceType: pattern.sourceType, identifier };
    }
  }

  // Default: treat as a generic web article
  // Use the hostname + path as a rough identifier
  try {
    const parsed = new URL(cleanedUrl);
    const identifier = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
    return { sourceType: 'article', identifier };
  } catch {
    return { sourceType: 'article', identifier: cleanedUrl };
  }
}

/**
 * Detect all content items in a text message. Extracts all URLs and
 * classifies each one. If no URLs are found, the entire text is treated
 * as plain_text content.
 *
 * Returns an array of DetectedContent, deduplicated by normalized URL.
 */
export function detectContent(text: string): DetectedContent[] {
  const urlMatches = text.match(GENERIC_URL_RE);

  if (!urlMatches || urlMatches.length === 0) {
    // No URLs found -- treat entire text as plain text
    if (text.trim().length > 0) {
      return [
        {
          sourceType: 'plain_text',
          url: '',
          rawUrl: '',
          identifier: `text-${Date.now()}`,
        },
      ];
    }
    return [];
  }

  const seen = new Set<string>();
  const results: DetectedContent[] = [];

  for (const rawUrl of urlMatches) {
    // Clean trailing punctuation
    const cleaned = rawUrl.replace(/[.,;:!?)}\]]+$/, '');

    const { sourceType, identifier } = classifyUrl(cleaned);
    if (identifier === '') continue;

    // Normalize the URL for deduplication
    let normalizedUrl = cleaned;
    for (const pattern of URL_PATTERNS) {
      const match = cleaned.match(pattern.regex);
      if (match) {
        const testId = pattern.extractIdentifier(match);
        if (testId !== '') {
          normalizedUrl = pattern.normalizeUrl(match, cleaned);
          break;
        }
      }
    }

    // Deduplicate by normalized URL
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    results.push({
      sourceType,
      url: normalizedUrl,
      rawUrl: cleaned,
      identifier,
    });
  }

  return results;
}
