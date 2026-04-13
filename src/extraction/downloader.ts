import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { ReelMetadata } from '../types.js';

const execFileAsync = promisify(execFile);

const YT_DLP = '/opt/homebrew/bin/yt-dlp';

/**
 * Extract the shortcode from an Instagram URL.
 * Handles /reel/, /p/, query params, trailing slashes, and share URLs.
 *
 * Examples:
 *   https://www.instagram.com/reel/ABC123/ -> ABC123
 *   https://www.instagram.com/p/ABC123/?utm=foo -> ABC123
 *   https://www.instagram.com/reel/ABC123 -> ABC123
 */
export function extractShortcode(url: string): string {
  // Remove query string and hash fragment
  const cleaned = url.split('?')[0].split('#')[0];

  // Match /reel/ or /p/ followed by the shortcode
  const match = cleaned.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
  if (match) {
    return match[1];
  }

  // Fallback: try the last non-empty path segment
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length > 0) {
    return segments[segments.length - 1];
  }

  throw new Error(`Could not extract shortcode from URL: ${url}`);
}

/**
 * Download a reel video and its metadata using yt-dlp.
 * Returns the path to the video file and parsed metadata.
 */
export async function downloadReel(
  url: string,
  workDir: string,
): Promise<{ videoPath: string; metadata: ReelMetadata }> {
  const outputTemplate = path.join(workDir, '%(id)s.%(ext)s');

  // Download video and write info JSON
  await execFileAsync(
    YT_DLP,
    [
      '--no-warnings',
      '--no-playlist',
      '--write-info-json',
      '--cookies-from-browser', 'chrome',
      '--output', outputTemplate,
      url,
    ],
    { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
  );

  // Find the downloaded video and info JSON
  const files = await readdir(workDir);
  const videoFile = files.find(
    f => !f.endsWith('.json') && !f.endsWith('.part') && !f.startsWith('.'),
  );
  if (!videoFile) {
    throw new Error(`No video file found in ${workDir} after download`);
  }

  const infoFile = files.find(f => f.endsWith('.info.json'));
  if (!infoFile) {
    throw new Error(`No info JSON found in ${workDir} after download`);
  }

  const videoPath = path.join(workDir, videoFile);
  const infoPath = path.join(workDir, infoFile);

  // Parse metadata from yt-dlp JSON
  const raw = JSON.parse(await readFile(infoPath, 'utf-8'));

  const description: string = raw.description || raw.title || '';
  const hashtagRegex = /#[\w]+/g;
  const hashtags = (description.match(hashtagRegex) || []).map((h: string) =>
    h.toLowerCase(),
  );

  const metadata: ReelMetadata = {
    author: raw.uploader || raw.channel || raw.creator || 'unknown',
    authorId: raw.uploader_id || raw.channel_id || '',
    title: raw.title || raw.fulltitle || '',
    description,
    duration: raw.duration || 0,
    viewCount: raw.view_count || 0,
    likeCount: raw.like_count || 0,
    commentCount: raw.comment_count || 0,
    uploadDate: raw.upload_date || '',
    thumbnailUrl: raw.thumbnail || '',
    hashtags,
  };

  return { videoPath, metadata };
}
