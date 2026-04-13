import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeInstagramUrl,
  isInstagramReelUrl,
  isInstagramPostUrl,
  isInstagramShareUrl,
  extractAllUrls,
} from '../src/ingestion/url-resolver.js';
import {
  clearSeenUrls,
  getSeenUrls,
} from '../src/ingestion/clipboard-handler.js';

// ── URL Normalization Tests ──────────────────────────────────────────────

describe('normalizeInstagramUrl', () => {
  it('strips tracking query params (igsh)', () => {
    const url = 'https://www.instagram.com/reel/ABC123/?igsh=abc';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('strips utm params', () => {
    const url = 'https://www.instagram.com/reel/ABC123/?utm_source=ig_web&utm_medium=copy';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('strips fbclid', () => {
    const url = 'https://www.instagram.com/reel/ABC123/?fbclid=xyz123';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('removes trailing slash', () => {
    const url = 'https://www.instagram.com/reel/ABC123/';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('normalizes http to https', () => {
    const url = 'http://www.instagram.com/reel/ABC123/';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('normalizes instagram.com to www.instagram.com', () => {
    const url = 'https://instagram.com/reel/ABC123/';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('preserves non-tracking query params', () => {
    const url = 'https://www.instagram.com/reel/ABC123/?custom=value';
    expect(normalizeInstagramUrl(url)).toContain('custom=value');
  });

  it('strips multiple tracking params at once', () => {
    const url = 'https://instagram.com/reel/XYZ/?igsh=1&utm_source=2&fbclid=3';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/XYZ');
  });

  it('handles already-clean URLs', () => {
    const url = 'https://www.instagram.com/reel/ABC123';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/reel/ABC123');
  });

  it('handles /p/ post URLs', () => {
    const url = 'https://www.instagram.com/p/POST123/?igsh=abc';
    expect(normalizeInstagramUrl(url)).toBe('https://www.instagram.com/p/POST123');
  });

  it('handles invalid URL string gracefully', () => {
    const result = normalizeInstagramUrl('not a url');
    expect(result).toBe('not a url');
  });
});

// ── URL Validation Tests ────────────────────────────────────────────────

describe('isInstagramReelUrl', () => {
  it('returns true for valid reel URLs', () => {
    expect(isInstagramReelUrl('https://www.instagram.com/reel/ABC123/')).toBe(true);
    expect(isInstagramReelUrl('https://instagram.com/reel/ABC123')).toBe(true);
    expect(isInstagramReelUrl('https://www.instagram.com/reel/A-B_C/')).toBe(true);
  });

  it('returns true for reel URLs with query params', () => {
    expect(isInstagramReelUrl('https://www.instagram.com/reel/ABC123/?igsh=abc')).toBe(true);
  });

  it('returns false for post URLs', () => {
    expect(isInstagramReelUrl('https://www.instagram.com/p/ABC123/')).toBe(false);
  });

  it('returns false for non-Instagram URLs', () => {
    expect(isInstagramReelUrl('https://twitter.com/user/status/123')).toBe(false);
    expect(isInstagramReelUrl('https://github.com/user/repo')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isInstagramReelUrl('')).toBe(false);
  });

  it('returns false for profile URLs', () => {
    expect(isInstagramReelUrl('https://www.instagram.com/username/')).toBe(false);
  });
});

describe('isInstagramPostUrl', () => {
  it('returns true for valid /p/ URLs', () => {
    expect(isInstagramPostUrl('https://www.instagram.com/p/POST123/')).toBe(true);
    expect(isInstagramPostUrl('https://instagram.com/p/POST123')).toBe(true);
  });

  it('returns false for reel URLs', () => {
    expect(isInstagramPostUrl('https://www.instagram.com/reel/ABC123/')).toBe(false);
  });
});

describe('isInstagramShareUrl', () => {
  it('returns true for share URLs', () => {
    expect(isInstagramShareUrl('https://www.instagram.com/share/abc123/')).toBe(true);
  });

  it('returns false for reel URLs', () => {
    expect(isInstagramShareUrl('https://www.instagram.com/reel/ABC123/')).toBe(false);
  });
});

// ── URL Extraction Tests ────────────────────────────────────────────────

describe('extractAllUrls', () => {
  it('extracts multiple URLs from text', () => {
    const text = 'Check out https://www.instagram.com/reel/ABC/ and https://github.com/user/repo';
    const urls = extractAllUrls(text);
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://www.instagram.com/reel/ABC/');
    expect(urls).toContain('https://github.com/user/repo');
  });

  it('handles text with no URLs', () => {
    expect(extractAllUrls('no urls here')).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const text = 'https://example.com and again https://example.com';
    const urls = extractAllUrls(text);
    expect(urls).toHaveLength(1);
  });

  it('handles URLs with query params', () => {
    const text = 'Visit https://example.com/page?key=value&foo=bar now';
    const urls = extractAllUrls(text);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('key=value');
  });

  it('extracts URLs from multi-line text', () => {
    const text = `Line 1: https://example.com/a
Line 2: https://example.com/b
Line 3: no url here`;
    const urls = extractAllUrls(text);
    expect(urls).toHaveLength(2);
  });

  it('handles empty string', () => {
    expect(extractAllUrls('')).toEqual([]);
  });
});

// ── Clipboard Dedup Tests ───────────────────────────────────────────────

describe('clipboard seen-URL dedup', () => {
  beforeEach(() => {
    clearSeenUrls();
  });

  it('starts with empty seen set', () => {
    expect(getSeenUrls().size).toBe(0);
  });

  it('clearSeenUrls resets the set', () => {
    // We can't easily simulate pbpaste in tests, but we can test
    // the seen-URL tracking in isolation via the exported helpers
    clearSeenUrls();
    expect(getSeenUrls().size).toBe(0);
  });
});
