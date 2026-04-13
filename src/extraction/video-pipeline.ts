// ── Universal Video Pipeline ─────────────────────────────────────────────
//
// Handles video extraction from ANY platform that yt-dlp supports:
// Instagram reels, YouTube videos, YouTube Shorts, TikTok, and more.
//
// Steps:
// 1. Extract a platform-specific identifier from the URL
// 2. Download video + metadata via yt-dlp
// 3. Extract audio → transcribe via Whisper
// 4. Sample frames → OCR via OpenClaw LLM
// 5. Analyze all content via OpenClaw LLM (with source-type-aware prompt)
//
// This is a refactored version of the original Instagram-only pipeline.ts.

import { mkdir } from 'fs/promises';
import path from 'path';
import { downloadReel } from './downloader.js';
import { extractAudio, transcribe } from './transcriber.js';
import { sampleFrames } from './frame-sampler.js';
import { ocrFrames } from './ocr.js';
import { analyzeContent } from './llm-analyzer.js';
import type { SourceType } from '../ingestion/url-router.js';
import type { PipelineConfig, ExtractionResult, ReelMetadata } from '../types.js';

// ── Identifier extraction ────────────────────────────────────────────────

/**
 * Extract a unique identifier from a video URL based on its platform.
 *
 * - Instagram: shortcode from /reel/ABC123/ or /p/ABC123/
 * - YouTube: video ID from ?v=ABC123, youtu.be/ABC123, or /shorts/ABC123
 * - TikTok: video ID from /video/1234567890
 * - Fallback: last non-empty URL path segment
 */
export function extractVideoIdentifier(url: string, sourceType: SourceType): string {
  // Remove query string and hash for cleaner matching
  const cleaned = url.split('?')[0].split('#')[0];

  switch (sourceType) {
    case 'instagram_reel': {
      const match = cleaned.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
      if (match) return match[1];
      break;
    }

    case 'youtube': {
      // YouTube Shorts: /shorts/VIDEO_ID
      const shortsMatch = cleaned.match(/\/shorts\/([A-Za-z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];

      // Standard watch URL: ?v=VIDEO_ID (need to check original URL for this)
      const watchMatch = url.match(/[?&]v=([A-Za-z0-9_-]+)/);
      if (watchMatch) return watchMatch[1];

      // Short link: youtu.be/VIDEO_ID
      const shortMatch = cleaned.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
      if (shortMatch) return shortMatch[1];
      break;
    }

    case 'tiktok': {
      // Full URL: /video/1234567890
      const videoMatch = cleaned.match(/\/video\/(\d+)/);
      if (videoMatch) return videoMatch[1];

      // Short link: vm.tiktok.com/XXXXXX
      const shortMatch = cleaned.match(/vm\.tiktok\.com\/([A-Za-z0-9]+)/);
      if (shortMatch) return shortMatch[1];
      break;
    }

    default:
      break;
  }

  // Fallback: use the last non-empty path segment
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length > 0) {
    return segments[segments.length - 1];
  }

  throw new Error(`Could not extract video identifier from URL: ${url}`);
}

// ── Logging helper ───────────────────────────────────────────────────────

function log(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] ${step}: ${msg}`);
}

// ── Video extraction pipeline ────────────────────────────────────────────

/**
 * Full extraction pipeline for any video URL.
 *
 * Works for Instagram reels, YouTube videos, YouTube Shorts, TikTok, and
 * any other platform that yt-dlp supports. The pipeline:
 *
 * 1. Extracts a platform-specific identifier
 * 2. Downloads the video and metadata via yt-dlp
 * 3. Extracts audio and transcribes via Whisper
 * 4. Samples frames and runs OCR via OpenClaw LLM
 * 5. Analyzes all collected content via OpenClaw LLM
 *
 * Returns an ExtractionResult compatible with the existing storage layer.
 */
export async function extractFromVideo(
  url: string,
  sourceType: SourceType,
  config: PipelineConfig,
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const sessionPrefix = `ke-${Date.now()}`;

  // Step 1: Extract identifier
  log('identifier', `Extracting from ${sourceType} URL...`);
  const identifier = extractVideoIdentifier(url, sourceType);
  log('identifier', identifier);

  // Step 2: Create working directory
  // Use sourceType prefix to avoid collisions between platforms
  const workDirName = `${sourceType}-${identifier}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const workDir = path.join(config.mediaDir, workDirName);
  await mkdir(workDir, { recursive: true });
  log('workdir', workDir);

  // Step 3: Download video via yt-dlp
  // The existing downloadReel function uses yt-dlp which supports all these platforms
  log('download', `Downloading ${sourceType} video...`);
  const { videoPath, metadata } = await downloadReel(url, workDir);
  log('download', `Done (${metadata.duration}s video by @${metadata.authorId || metadata.author})`);

  // Step 4: Extract audio
  let audioPath = '';
  try {
    log('audio', 'Extracting audio...');
    audioPath = await extractAudio(videoPath, workDir);
    log('audio', 'Done');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('audio', `Skipped -- ${msg}`);
  }

  // Step 5: Transcribe
  let transcript = '';
  if (audioPath) {
    try {
      log('transcribe', `Transcribing with model "${config.whisperModel || 'base'}"...`);
      transcript = await transcribe(audioPath, config.whisperModel || 'base');
      log('transcribe', transcript ? `Done (${transcript.length} chars)` : 'No speech detected');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('transcribe', `Failed -- ${msg}`);
    }
  } else {
    log('transcribe', 'Skipped -- no audio extracted');
  }

  // Step 6: Sample frames
  let framePaths: string[] = [];
  try {
    log('frames', 'Sampling frames...');
    framePaths = await sampleFrames(videoPath, workDir, { intervalSeconds: 2 });
    log('frames', `Extracted ${framePaths.length} frames`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('frames', `Failed -- ${msg}`);
  }

  // Step 7: OCR frames
  let ocrTexts: string[] = [];
  if (framePaths.length > 0) {
    try {
      log('ocr', `OCR on ${Math.min(framePaths.length, config.maxOcrFrames || 5)} frames...`);
      ocrTexts = await ocrFrames(framePaths, sessionPrefix);
      log('ocr', `Extracted text from ${ocrTexts.length} frames`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ocr', `Failed -- ${msg}`);
    }
  } else {
    log('ocr', 'Skipped -- no frames extracted');
  }

  // Step 8: Analyze with LLM (source-type-aware)
  log('analyze', `Analyzing ${sourceType} content with LLM...`);
  const knowledge = await analyzeContent(
    {
      caption: metadata.description,
      transcript,
      ocrTexts,
      metadata,
    },
    sessionPrefix,
    sourceType,
  );
  log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

  const processingTimeMs = Date.now() - startTime;
  log('complete', `Total: ${(processingTimeMs / 1000).toFixed(1)}s`);

  return {
    url,
    shortcode: identifier,
    metadata,
    transcript,
    ocrTexts,
    knowledge,
    processingTimeMs,
  };
}
