import { mkdir } from 'fs/promises';
import path from 'path';
import { extractShortcode, downloadReel } from './downloader.js';
import { extractAudio, transcribe } from './transcriber.js';
import { sampleFrames } from './frame-sampler.js';
import { ocrFrames } from './ocr.js';
import { analyzeContent } from './llm-analyzer.js';
import type { PipelineConfig, ExtractionResult } from '../types.js';

/**
 * Log a pipeline step with timing info.
 */
function log(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] ${step}: ${msg}`);
}

/**
 * Full extraction pipeline for an Instagram reel.
 *
 * Steps:
 * 1. Extract shortcode from URL
 * 2. Create working directory
 * 3. Download reel video + metadata via yt-dlp
 * 4. Extract audio from video via ffmpeg
 * 5. Transcribe audio via Whisper
 * 6. Sample frames from video via ffmpeg
 * 7. OCR selected frames via OpenClaw LLM
 * 8. Analyze all content via OpenClaw LLM
 *
 * Each step is wrapped in try/catch -- partial failures are handled gracefully.
 */
export async function extractFromReel(
  url: string,
  config: PipelineConfig,
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const sessionPrefix = `ke-${Date.now()}`;

  // Step 1: Extract shortcode
  log('shortcode', 'Extracting from URL...');
  const shortcode = extractShortcode(url);
  log('shortcode', shortcode);

  // Step 2: Create working directory
  const workDir = path.join(config.mediaDir, shortcode);
  await mkdir(workDir, { recursive: true });
  log('workdir', workDir);

  // Step 3: Download reel
  log('download', 'Downloading reel...');
  const { videoPath, metadata } = await downloadReel(url, workDir);
  log('download', `Done (${metadata.duration}s video by @${metadata.authorId})`);

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

  // Step 8: Analyze with LLM
  log('analyze', 'Analyzing content with LLM...');
  const knowledge = await analyzeContent(
    {
      caption: metadata.description,
      transcript,
      ocrTexts,
      metadata,
    },
    sessionPrefix,
  );
  log('analyze', `Done -- type: ${knowledge.contentType}, entities: ${knowledge.entities.length}`);

  const processingTimeMs = Date.now() - startTime;
  log('complete', `Total: ${(processingTimeMs / 1000).toFixed(1)}s`);

  return {
    url,
    shortcode,
    metadata,
    transcript,
    ocrTexts,
    knowledge,
    processingTimeMs,
  };
}
