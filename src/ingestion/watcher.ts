import { readFile, rename, mkdir, readdir } from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────

export interface InboxWatcherConfig {
  /** Directory to watch for new .txt URL files */
  inboxDir: string;
  /** Directory to move processed files to */
  processedDir: string;
  /** Callback invoked for each discovered URL */
  onUrl: (url: string, sourceFile: string) => Promise<void>;
  /** Optional logger */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ── URL extraction from file ─────────────────────────────────────────────

/**
 * Parse a text file and extract URLs (one per line).
 * Lines starting with # are comments and are skipped.
 * Empty lines are skipped.
 */
function extractUrlsFromFile(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .filter(line => line.startsWith('http'));
}

// ── Watcher state ────────────────────────────────────────────────────────

let fsWatcher: FSWatcher | null = null;
let isRunning = false;

// Track files currently being processed to avoid duplicates
const processingFiles = new Set<string>();

// ── Process a single file ────────────────────────────────────────────────

async function processFile(
  filePath: string,
  config: InboxWatcherConfig,
): Promise<void> {
  const filename = path.basename(filePath);

  // Skip non-txt files
  if (!filename.endsWith('.txt')) return;

  // Skip files already being processed
  if (processingFiles.has(filename)) return;
  processingFiles.add(filename);

  const log = config.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  try {
    const content = await readFile(filePath, 'utf-8');
    const urls = extractUrlsFromFile(content);

    if (urls.length === 0) {
      log.warn(`[watcher] No URLs found in ${filename}`);
    }

    for (const url of urls) {
      try {
        await config.onUrl(url, filename);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[watcher] Failed to process URL ${url}: ${msg}`);
      }
    }

    // Move processed file
    await mkdir(config.processedDir, { recursive: true });
    const destPath = path.join(config.processedDir, filename);
    await rename(filePath, destPath);
    log.info(`[watcher] Processed and moved: ${filename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[watcher] Error processing ${filename}: ${msg}`);
  } finally {
    processingFiles.delete(filename);
  }
}

// ── Scan existing files ──────────────────────────────────────────────────

async function scanExistingFiles(config: InboxWatcherConfig): Promise<void> {
  try {
    const files = await readdir(config.inboxDir);
    const txtFiles = files.filter(f => f.endsWith('.txt'));

    for (const filename of txtFiles) {
      const filePath = path.join(config.inboxDir, filename);
      await processFile(filePath, config);
    }
  } catch {
    // Directory may not exist yet; that is fine
  }
}

// ── Start / Stop ─────────────────────────────────────────────────────────

/**
 * Start watching the inbox directory for new .txt files containing URLs.
 *
 * 1. Ensures the inbox directory exists
 * 2. Processes any existing files
 * 3. Watches for new files using fs.watch
 *
 * Each new .txt file is read, URLs extracted, callback invoked,
 * then the file is moved to the processed directory.
 */
export async function startInboxWatcher(
  config: InboxWatcherConfig,
): Promise<void> {
  if (isRunning) {
    throw new Error('Inbox watcher is already running');
  }

  const log = config.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  // Ensure directories exist
  await mkdir(config.inboxDir, { recursive: true });
  await mkdir(config.processedDir, { recursive: true });

  // Process existing files first
  await scanExistingFiles(config);

  // Start watching
  fsWatcher = watch(config.inboxDir, (eventType, filename) => {
    if (
      eventType === 'rename' &&
      filename &&
      filename.endsWith('.txt')
    ) {
      const filePath = path.join(config.inboxDir, filename);
      // Use void to handle the promise without blocking the callback
      void processFile(filePath, config);
    }
  });

  fsWatcher.on('error', (err) => {
    log.error(`[watcher] FSWatcher error: ${err.message}`);
  });

  isRunning = true;
  log.info(`[watcher] Watching inbox: ${config.inboxDir}`);
}

/**
 * Stop the inbox watcher and clean up resources.
 */
export function stopInboxWatcher(): void {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
  isRunning = false;
}
