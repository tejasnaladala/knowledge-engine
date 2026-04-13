import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  detectContent,
  type DetectedContent,
} from '../ingestion/url-router.js';

// ── Instagram reel URL detection (legacy) ─────────────────────────────────

/**
 * Regular expression to match Instagram reel and post URLs.
 *
 * Matches:
 * - https://www.instagram.com/reel/SHORTCODE/
 * - https://instagram.com/reel/SHORTCODE
 * - https://www.instagram.com/p/SHORTCODE/
 * - https://www.instagram.com/reel/SHORTCODE/?utm_source=...
 */
const INSTAGRAM_REEL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)\/?(?:\?[^\s]*)?/g;

/**
 * Detect all Instagram reel URLs in the given text.
 * Returns an array of unique, full reel URLs (deduplicated).
 *
 * @deprecated Use detectContentUrls() for universal content detection.
 *             This function is kept for backwards compatibility and
 *             internally delegates to the new URL router.
 */
export function detectReelUrls(text: string): string[] {
  // Use the new universal router internally
  const detected = detectContent(text);
  return detected
    .filter(d => d.sourceType === 'instagram_reel')
    .map(d => d.url);
}

// ── Universal content URL detection ──────────────────────────────────────

/**
 * Detect all content URLs in the given text. Classifies each URL into
 * a source type (Instagram, YouTube, GitHub, Reddit, etc.) and extracts
 * a platform-specific identifier.
 *
 * If no URLs are found and the text is non-empty, returns a single
 * entry with sourceType 'plain_text'.
 *
 * This is the new universal replacement for detectReelUrls().
 */
export function detectContentUrls(text: string): DetectedContent[] {
  return detectContent(text);
}

// Re-export DetectedContent type for convenience
export type { DetectedContent } from '../ingestion/url-router.js';

// ── Queue reel for processing ────────────────────────────────────────────

/**
 * Queue a reel URL for processing by writing it to the inbox folder.
 * Each URL gets its own timestamped file for atomic processing.
 *
 * @param url       The Instagram reel URL to queue
 * @param inboxDir  Path to the inbox directory (e.g., data/inbox/)
 * @param method    How the URL was captured (e.g., "hook", "cli", "manual")
 */
export async function queueReelForProcessing(
  url: string,
  inboxDir: string,
  method: string,
): Promise<string> {
  await mkdir(inboxDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `reel-${timestamp}-${method}.txt`;
  const filePath = path.join(inboxDir, filename);

  const content = [
    `# Queued by: ${method}`,
    `# Timestamp: ${new Date(timestamp).toISOString()}`,
    url,
    '', // trailing newline
  ].join('\n');

  await writeFile(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Queue any content URL for processing by writing it to the inbox folder.
 * Stores the source type alongside the URL for proper routing on pickup.
 *
 * @param url        The URL to queue
 * @param sourceType The classified source type
 * @param inboxDir   Path to the inbox directory
 * @param method     How the URL was captured
 */
export async function queueContentForProcessing(
  url: string,
  sourceType: string,
  inboxDir: string,
  method: string,
): Promise<string> {
  await mkdir(inboxDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `content-${sourceType}-${timestamp}-${method}.txt`;
  const filePath = path.join(inboxDir, filename);

  const content = [
    `# Queued by: ${method}`,
    `# Source type: ${sourceType}`,
    `# Timestamp: ${new Date(timestamp).toISOString()}`,
    url,
    '', // trailing newline
  ].join('\n');

  await writeFile(filePath, content, 'utf-8');

  return filePath;
}
