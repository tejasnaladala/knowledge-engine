/**
 * Instagram Self-Chat Browser Scraper
 *
 * EXPERIMENTAL / BRITTLE
 *
 * This module uses Playwright to automate a Chromium browser session
 * and extract reel links from an Instagram direct message self-chat.
 *
 * The approach is inherently fragile because:
 * - Instagram's DOM structure changes frequently
 * - Login state depends on saved browser cookies
 * - Rate limiting and bot detection may block access
 * - Selectors may break without warning
 *
 * Use this as a one-shot scraping tool, not for production automation.
 * Always verify extracted URLs before processing.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface ScraperConfig {
  /** Path to saved Playwright browser storage state (cookies + localStorage) */
  cookiePath: string;
  /** Whether to run in headless mode (default: false for debugging) */
  headless?: boolean;
  /** Navigation timeout in ms (default: 30000) */
  timeout?: number;
}

export interface ScrapedResult {
  /** Reel URLs extracted from the self-chat */
  urls: string[];
  /** Number of scroll iterations performed */
  scrollCount: number;
  /** Whether the scraper encountered errors */
  hadErrors: boolean;
  /** Error message if any */
  errorMessage?: string;
}

// ── Instagram reel URL regex ────────────────────────────────────────────

const INSTAGRAM_REEL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+\/?/g;

// ── Scraper class ───────────────────────────────────────────────────────

/**
 * Instagram self-chat scraper using Playwright.
 *
 * Usage:
 *   const scraper = new InstagramScraper({ cookiePath: './state.json' });
 *   await scraper.init();
 *   const result = await scraper.scrapeReelLinks(10);
 *   await scraper.close();
 *
 * NOTE: Requires playwright-core to be installed.
 * This is marked as an optional/experimental feature.
 */
export class InstagramScraper {
  private config: Required<ScraperConfig>;
  private browser: unknown = null;
  private context: unknown = null;
  private page: unknown = null;

  constructor(config: ScraperConfig) {
    this.config = {
      cookiePath: config.cookiePath,
      headless: config.headless ?? false,
      timeout: config.timeout ?? 30000,
    };
  }

  /**
   * Launch Chromium with persisted cookie state.
   *
   * BRITTLE: Requires a valid storage state file from a previous
   * manual login session. Generate one by:
   *   1. Running Playwright codegen with --save-storage=state.json
   *   2. Logging into Instagram manually
   *   3. Saving the state file
   */
  async init(): Promise<void> {
    // Dynamic import -- playwright-core may not be installed
    let chromium: { launch: (opts: Record<string, unknown>) => Promise<unknown> };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pw = await (Function('return import("playwright-core")')() as Promise<{ chromium: typeof chromium }>);
      chromium = pw.chromium;
    } catch {
      throw new Error(
        'playwright-core is not installed. Install it with: npm install playwright-core\n' +
        'Then install browsers with: npx playwright install chromium',
      );
    }

    this.browser = await chromium.launch({
      headless: this.config.headless,
    });

    // Try to load saved storage state for cookies
    const contextOpts: Record<string, unknown> = {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    try {
      contextOpts.storageState = this.config.cookiePath;
    } catch {
      // No saved state -- will need manual login
    }

    const browser = this.browser as { newContext: (opts: Record<string, unknown>) => Promise<unknown> };
    this.context = await browser.newContext(contextOpts);

    const ctx = this.context as { newPage: () => Promise<unknown> };
    this.page = await ctx.newPage();
  }

  /**
   * Save the current browser storage state (cookies + localStorage)
   * for reuse in future sessions.
   */
  async saveCookies(): Promise<void> {
    if (!this.context) {
      throw new Error('Scraper not initialized. Call init() first.');
    }

    const ctx = this.context as {
      storageState: (opts: { path: string }) => Promise<void>;
    };
    await ctx.storageState({ path: this.config.cookiePath });
  }

  /**
   * Navigate to Instagram DMs, find self-chat, and extract reel links.
   *
   * BRITTLE: This relies on Instagram's current DOM structure.
   * Selectors will likely break when Instagram updates their frontend.
   *
   * @param maxScroll Maximum number of scroll iterations (default: 10)
   */
  async scrapeReelLinks(maxScroll: number = 10): Promise<ScrapedResult> {
    if (!this.page) {
      throw new Error('Scraper not initialized. Call init() first.');
    }

    const page = this.page as {
      goto: (url: string, opts?: Record<string, unknown>) => Promise<void>;
      waitForTimeout: (ms: number) => Promise<void>;
      content: () => Promise<string>;
      evaluate: (fn: () => void) => Promise<void>;
      waitForSelector: (selector: string, opts?: Record<string, unknown>) => Promise<unknown>;
    };

    const result: ScrapedResult = {
      urls: [],
      scrollCount: 0,
      hadErrors: false,
    };

    try {
      // Step 1: Navigate to Instagram DM inbox
      await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      // Wait for page to load
      await page.waitForTimeout(3000);

      // Step 2: Scroll and collect links
      const collectedUrls = new Set<string>();

      for (let i = 0; i < maxScroll; i++) {
        const html = await page.content();
        const matches = html.match(INSTAGRAM_REEL_RE) ?? [];

        for (const url of matches) {
          collectedUrls.add(url);
        }

        // Scroll down in the chat area
        await page.evaluate(() => {
          const chatContainer = document.querySelector('[role="main"]');
          if (chatContainer) {
            chatContainer.scrollTop += 500;
          }
        });

        await page.waitForTimeout(1500);
        result.scrollCount++;
      }

      result.urls = [...collectedUrls];
    } catch (err: unknown) {
      result.hadErrors = true;
      result.errorMessage = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Close browser and clean up all resources.
   */
  async close(): Promise<void> {
    if (this.browser) {
      const browser = this.browser as { close: () => Promise<void> };
      await browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
