import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Instagram reel URL regex ────────────────────────────────────────────

const INSTAGRAM_REEL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+\/?(?:\?[^\s]*)?/;

// ── Seen URL tracking ───────────────────────────────────────────────────

const seenUrls = new Set<string>();

/**
 * Clear the seen-URLs set. Useful for testing.
 */
export function clearSeenUrls(): void {
  seenUrls.clear();
}

/**
 * Get the current set of seen URLs. Useful for testing.
 */
export function getSeenUrls(): ReadonlySet<string> {
  return seenUrls;
}

// ── Clipboard check ─────────────────────────────────────────────────────

/**
 * Read the macOS clipboard via `pbpaste` and return the content if it
 * matches an Instagram reel URL. Returns null otherwise.
 *
 * Only works on macOS (uses pbpaste).
 */
export async function checkClipboard(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('pbpaste', [], {
      timeout: 3000,
      maxBuffer: 1024 * 10, // 10KB max -- clipboard should be small
    });

    const trimmed = stdout.trim();
    if (!trimmed) return null;

    const match = trimmed.match(INSTAGRAM_REEL_RE);
    return match ? match[0] : null;
  } catch {
    // pbpaste not available (not macOS) or timeout
    return null;
  }
}

// ── Clipboard monitor ───────────────────────────────────────────────────

/**
 * Start polling the clipboard at the given interval (in milliseconds).
 * When a new Instagram reel URL is detected, invokes the `onUrl` callback.
 *
 * Tracks already-processed URLs to avoid re-processing the same URL.
 *
 * @returns A timer handle that can be passed to `stopClipboardMonitor`.
 */
export function startClipboardMonitor(
  intervalMs: number,
  onUrl: (url: string) => Promise<void>,
): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const url = await checkClipboard();
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        await onUrl(url);
      }
    } catch {
      // Silently swallow polling errors to keep the monitor alive
    }
  }, intervalMs);

  return timer;
}

/**
 * Stop the clipboard monitor.
 */
export function stopClipboardMonitor(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}
