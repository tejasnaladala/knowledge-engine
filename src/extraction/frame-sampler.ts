import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, mkdir } from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

export interface FrameSampleOptions {
  /** Interval in seconds between frame captures. Default: 2 */
  intervalSeconds?: number;
}

/**
 * Sample frames from a video at regular intervals using ffmpeg.
 * Returns an array of file paths to the extracted frame images.
 */
export async function sampleFrames(
  videoPath: string,
  workDir: string,
  opts: FrameSampleOptions = {},
): Promise<string[]> {
  const interval = opts.intervalSeconds ?? 2;
  const framesDir = path.join(workDir, 'frames');
  await mkdir(framesDir, { recursive: true });

  const outputPattern = path.join(framesDir, 'frame_%04d.png');

  try {
    await execFileAsync(
      FFMPEG,
      [
        '-i', videoPath,
        '-vf', `fps=1/${interval}`,
        '-q:v', '2',
        '-y',
        outputPattern,
      ],
      { timeout: 60_000 },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[frame-sampler] ffmpeg frame extraction warning: ${msg}`);
    // Continue -- some frames may still have been generated
  }

  // Collect all generated frame files, sorted by name
  const files = await readdir(framesDir);
  const framePaths = files
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort()
    .map(f => path.join(framesDir, f));

  return framePaths;
}
