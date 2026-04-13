import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, access } from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const WHISPER = '/opt/homebrew/bin/whisper';

/**
 * Extract audio from a video file as a 16kHz mono WAV using ffmpeg.
 * Returns the path to the extracted audio file.
 */
export async function extractAudio(
  videoPath: string,
  workDir: string,
): Promise<string> {
  const audioPath = path.join(workDir, 'audio.wav');

  await execFileAsync(
    FFMPEG,
    [
      '-i', videoPath,
      '-vn',                   // no video
      '-acodec', 'pcm_s16le', // 16-bit PCM
      '-ar', '16000',          // 16kHz
      '-ac', '1',              // mono
      '-y',                    // overwrite
      audioPath,
    ],
    { timeout: 60_000 },
  );

  return audioPath;
}

/**
 * Transcribe an audio file using OpenAI Whisper CLI.
 * Returns the transcribed text.
 *
 * @param audioPath - Path to the WAV audio file
 * @param model - Whisper model size: "base", "small", "medium" (default: "base")
 */
export async function transcribe(
  audioPath: string,
  model: string = 'base',
): Promise<string> {
  const outputDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));

  try {
    await execFileAsync(
      WHISPER,
      [
        audioPath,
        '--model', model,
        '--output_dir', outputDir,
        '--output_format', 'txt',
        '--language', 'en',
        '--fp16', 'False',
      ],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Whisper may exit with non-zero if audio is very short or silent
    // Check if output file was still created
    const txtPath = path.join(outputDir, `${baseName}.txt`);
    try {
      await access(txtPath);
      // File exists despite error -- read it anyway
    } catch {
      console.warn(`[transcriber] Whisper failed and no output produced: ${msg}`);
      return '';
    }
  }

  // Read the .txt output file whisper generates
  const txtPath = path.join(outputDir, `${baseName}.txt`);
  try {
    const text = await readFile(txtPath, 'utf-8');
    return text.trim();
  } catch {
    console.warn('[transcriber] No transcript file found -- audio may be silent');
    return '';
  }
}
