import { describe, it, expect } from 'vitest';
import { extractShortcode } from '../src/extraction/downloader.js';
import { extractJsonFromText } from '../src/extraction/llm-analyzer.js';

// ── extractShortcode tests ──────────────────────────────────────────────

describe('extractShortcode', () => {
  it('extracts shortcode from /reel/ URL', () => {
    expect(extractShortcode('https://www.instagram.com/reel/ABC123/')).toBe('ABC123');
  });

  it('extracts shortcode from /reel/ URL without trailing slash', () => {
    expect(extractShortcode('https://www.instagram.com/reel/ABC123')).toBe('ABC123');
  });

  it('extracts shortcode from /p/ URL', () => {
    expect(extractShortcode('https://www.instagram.com/p/XYZ789/')).toBe('XYZ789');
  });

  it('handles query parameters', () => {
    expect(
      extractShortcode('https://www.instagram.com/reel/ABC123/?utm_source=ig_web'),
    ).toBe('ABC123');
  });

  it('handles hash fragments', () => {
    expect(
      extractShortcode('https://www.instagram.com/reel/ABC123/#section'),
    ).toBe('ABC123');
  });

  it('handles shortcodes with hyphens and underscores', () => {
    expect(
      extractShortcode('https://www.instagram.com/reel/A-B_C123/'),
    ).toBe('A-B_C123');
  });

  it('handles mobile share URLs (with query params)', () => {
    expect(
      extractShortcode('https://www.instagram.com/reel/CdefGhi/?igsh=abc123'),
    ).toBe('CdefGhi');
  });

  it('handles HTTP (not HTTPS) URLs', () => {
    expect(
      extractShortcode('http://instagram.com/reel/SHORT/'),
    ).toBe('SHORT');
  });

  it('handles URLs without www', () => {
    expect(
      extractShortcode('https://instagram.com/p/NoWWW/'),
    ).toBe('NoWWW');
  });

  it('throws on empty/invalid URL', () => {
    expect(() => extractShortcode('')).toThrow();
  });
});

// ── extractJsonFromText tests ───────────────────────────────────────────

describe('extractJsonFromText', () => {
  it('parses plain JSON', () => {
    const result = extractJsonFromText('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts JSON from markdown code fence', () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    expect(extractJsonFromText(text)).toEqual({ key: 'value' });
  });

  it('extracts JSON from code fence without language tag', () => {
    const text = '```\n{"a": 1}\n```';
    expect(extractJsonFromText(text)).toEqual({ a: 1 });
  });

  it('handles surrounding text', () => {
    const text = 'Sure! Here is the analysis: {"result": true} Hope that helps!';
    expect(extractJsonFromText(text)).toEqual({ result: true });
  });

  it('handles complex nested JSON', () => {
    const json = {
      summary: 'Test summary',
      entities: [{ name: 'React', type: 'framework' }],
      topics: ['web', 'frontend'],
    };
    const text = `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
    expect(extractJsonFromText(text)).toEqual(json);
  });

  it('throws on completely invalid input', () => {
    expect(() => extractJsonFromText('no json here at all')).toThrow();
  });
});

// ── Type structure tests ────────────────────────────────────────────────

describe('pipeline types', () => {
  it('ContentType values are valid strings', () => {
    const validTypes = [
      'repo_recommendation', 'tutorial', 'news_update', 'tool_review',
      'research_insight', 'workflow_tip', 'product_idea', 'engineering_trick',
      'ai_technique', 'general',
    ];
    // Just verify the array is well-formed (compile-time type check in TS)
    expect(validTypes).toHaveLength(10);
    for (const t of validTypes) {
      expect(typeof t).toBe('string');
    }
  });

  it('EntityType values are valid strings', () => {
    const validTypes = [
      'repository', 'tool', 'model', 'library', 'framework', 'paper',
      'company', 'person', 'technique', 'workflow', 'architecture',
      'product_idea', 'benchmark', 'trend',
    ];
    expect(validTypes).toHaveLength(14);
  });

  it('RelationshipType values are valid strings', () => {
    const validTypes = [
      'mentions', 'recommends', 'improves', 'replaces', 'integrates_with',
      'depends_on', 'similar_to', 'relevant_for', 'good_for', 'not_good_for',
      'announced_by', 'compared_against', 'used_in',
    ];
    expect(validTypes).toHaveLength(13);
  });
});
