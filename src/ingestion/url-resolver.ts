// ── URL normalization and validation for Instagram content ──────────────

/**
 * Regex matching Instagram reel URLs.
 * Matches: /reel/SHORTCODE/ with optional query params.
 */
const REEL_URL_RE =
  /^https?:\/\/(?:www\.)?instagram\.com\/reel\/[A-Za-z0-9_-]+\/?(?:\?[^\s]*)?$/;

/**
 * Regex matching Instagram post URLs.
 * Matches: /p/SHORTCODE/ with optional query params.
 */
const POST_URL_RE =
  /^https?:\/\/(?:www\.)?instagram\.com\/p\/[A-Za-z0-9_-]+\/?(?:\?[^\s]*)?$/;

/**
 * Regex matching Instagram share/short URLs.
 */
const SHARE_URL_RE =
  /^https?:\/\/(?:www\.)?instagram\.com\/share\/[A-Za-z0-9_-]+\/?/;

/**
 * General URL regex for extracting all URLs from text.
 */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Query parameters to strip during normalization (tracking/analytics params).
 */
const TRACKING_PARAMS = [
  'igsh', 'igshid', 'ig_rid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'ref', 'share_id',
];

// ── URL validation ──────────────────────────────────────────────────────

/**
 * Check if a string is a valid Instagram reel URL.
 */
export function isInstagramReelUrl(url: string): boolean {
  return REEL_URL_RE.test(url.trim());
}

/**
 * Check if a string is a valid Instagram post URL (/p/).
 */
export function isInstagramPostUrl(url: string): boolean {
  return POST_URL_RE.test(url.trim());
}

/**
 * Check if a string is an Instagram share/short URL.
 */
export function isInstagramShareUrl(url: string): boolean {
  return SHARE_URL_RE.test(url.trim());
}

// ── URL normalization ───────────────────────────────────────────────────

/**
 * Normalize an Instagram URL to its canonical form:
 * - Strip tracking/analytics query parameters (igsh, utm_*, fbclid, etc.)
 * - Remove trailing slashes
 * - Normalize to https://www.instagram.com/...
 *
 * Non-Instagram URLs are returned as-is with tracking params stripped.
 */
export function normalizeInstagramUrl(url: string): string {
  const trimmed = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // Normalize hostname to www.instagram.com
  if (parsed.hostname === 'instagram.com') {
    parsed.hostname = 'www.instagram.com';
  }

  // Ensure https
  parsed.protocol = 'https:';

  // Strip tracking params
  for (const param of TRACKING_PARAMS) {
    parsed.searchParams.delete(param);
  }

  // If no remaining params, clear the search entirely
  if ([...parsed.searchParams].length === 0) {
    parsed.search = '';
  }

  // Remove trailing slash from pathname (but keep root '/')
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  // Remove hash
  parsed.hash = '';

  return parsed.toString();
}

// ── URL extraction ──────────────────────────────────────────────────────

/**
 * Extract all URLs from a text block.
 * Returns an array of URL strings found in the text.
 */
export function extractAllUrls(text: string): string[] {
  const matches = text.match(URL_RE);
  if (!matches) return [];

  // Deduplicate
  return [...new Set(matches)];
}

// ── Short URL resolution ────────────────────────────────────────────────

/**
 * Resolve a shortened/redirect URL (e.g., instagram.com/share/...)
 * by following redirects manually.
 *
 * Uses fetch with `redirect: 'manual'` to capture the Location header
 * without following the full redirect chain automatically.
 *
 * Returns the final resolved URL, or the original URL if resolution fails.
 */
export async function resolveShortUrl(url: string): Promise<string> {
  const maxRedirects = 5;
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeEngine/1.0)',
        },
        signal: AbortSignal.timeout(5000),
      });

      const location = response.headers.get('location');
      if (!location || response.status < 300 || response.status >= 400) {
        // No redirect -- this is the final URL
        return currentUrl;
      }

      // Resolve relative redirect URLs
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      // Network error or timeout -- return what we have
      return currentUrl;
    }
  }

  return currentUrl;
}
