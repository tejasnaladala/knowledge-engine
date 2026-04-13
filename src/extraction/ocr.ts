import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Select up to `max` frames evenly distributed across the array.
 * Always includes the first and last frame if available.
 */
function selectFrames(framePaths: string[], max: number): string[] {
  if (framePaths.length <= max) return framePaths;

  const selected: string[] = [framePaths[0]];
  const remaining = max - 2; // first and last are reserved

  if (remaining > 0 && framePaths.length > 2) {
    const step = (framePaths.length - 2) / (remaining + 1);
    for (let i = 1; i <= remaining; i++) {
      const idx = Math.round(step * i);
      selected.push(framePaths[idx]);
    }
  }

  selected.push(framePaths[framePaths.length - 1]);
  return selected;
}

/**
 * Call OpenClaw CLI agent with a message.
 */
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

/**
 * Perform OCR on video frames by sending them to an LLM via OpenClaw CLI.
 * Selects up to 5 frames (first, last, and evenly spaced between) and
 * asks the LLM to extract all visible text from each frame.
 *
 * @param framePaths - Array of paths to frame image files
 * @param sessionPrefix - Prefix for OpenClaw session IDs
 * @returns Array of extracted text strings, one per frame
 */
export async function ocrFrames(
  framePaths: string[],
  sessionPrefix: string,
): Promise<string[]> {
  if (framePaths.length === 0) return [];

  const selected = selectFrames(framePaths, 5);
  const results: string[] = [];

  for (let i = 0; i < selected.length; i++) {
    const framePath = selected[i];
    const sessionId = `${sessionPrefix}-ocr-${i}-${Date.now()}`;

    try {
      // Read frame as base64
      const frameBuffer = await readFile(framePath);
      const base64 = frameBuffer.toString('base64');
      const ext = path.extname(framePath).slice(1) || 'png';
      const dataUri = `data:image/${ext};base64,${base64}`;

      const prompt = [
        'You are an OCR assistant. Extract ALL visible text from this image.',
        'Include: on-screen text, captions, subtitles, labels, URLs, code snippets,',
        'watermarks, usernames, and any other readable text.',
        '',
        'Rules:',
        '- Return ONLY the extracted text, nothing else',
        '- Preserve line breaks as they appear',
        '- If no text is visible, respond with exactly: [NO TEXT]',
        '- Do NOT describe the image -- only extract text',
        '',
        `Image: ${dataUri}`,
      ].join('\n');

      const text = await callOpenClaw(prompt, sessionId);
      const cleaned = text.trim();
      if (cleaned && cleaned !== '[NO TEXT]') {
        results.push(cleaned);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ocr] Failed to OCR frame ${i} (${path.basename(framePath)}): ${msg}`);
    }
  }

  return results;
}
