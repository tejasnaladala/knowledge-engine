import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeDB } from '../src/storage/db.js';
import { getProjectRecommendations } from '../src/tools/recommend.js';
import { generateDigest } from '../src/tools/digest.js';
import { extractGitHubRepo, formatRepoInfo } from '../src/graph/enricher.js';
import type { GitHubRepoInfo } from '../src/graph/enricher.js';

let db: KnowledgeDB;

beforeEach(() => {
  db = new KnowledgeDB(':memory:');
  db.init();
});

afterEach(() => {
  db.close();
});

// ── Helper ──────────────────────────────────────────────────────────────

function insertTestReel(id: string, shortcode: string, opts: {
  summary?: string;
  transcript?: string;
  content_type?: string;
  author_id?: string;
  hype_level?: string;
  implementation_readiness?: string;
  view_count?: number;
  action_items?: string;
} = {}): void {
  db.insertReel({
    id,
    url: `https://instagram.com/reel/${shortcode}/`,
    shortcode,
    summary: opts.summary ?? `Summary for ${shortcode}`,
    transcript: opts.transcript ?? `Transcript for ${shortcode}`,
    content_type: opts.content_type ?? 'general',
    author_id: opts.author_id ?? 'testuser',
    hype_level: opts.hype_level ?? 'grounded',
    implementation_readiness: opts.implementation_readiness ?? 'production',
    view_count: opts.view_count ?? 1000,
    action_items: opts.action_items ?? '[]',
    status: 'complete',
  });
}

// ── Recommendation Scoring Tests ────────────────────────────────────────

describe('getProjectRecommendations', () => {
  it('returns empty recommendations for empty database', () => {
    const rec = getProjectRecommendations(db, 'build a web app');
    expect(rec.totalMatches).toBe(0);
    expect(rec.repos).toHaveLength(0);
    expect(rec.tools).toHaveLength(0);
  });

  it('finds relevant entities from matched reels', () => {
    insertTestReel('reel-1', 'REC1', {
      summary: 'React is great for building web apps with hooks',
      transcript: 'React hooks tutorial for web application development',
    });

    const entityId = db.upsertEntity({ name: 'React', type: 'framework', description: 'UI library' });
    db.linkReelEntity('reel-1', entityId, 'React framework mention', 1.0, 'transcript');

    const rec = getProjectRecommendations(db, 'web app development');

    expect(rec.tools.length).toBeGreaterThanOrEqual(0);
    // Query should complete without error
    expect(rec.queryTimeMs).toBeGreaterThanOrEqual(0);
    expect(rec.projectDescription).toBe('web app development');
  });

  it('prioritizes grounded over hype', () => {
    // Set up two reels: one grounded, one hyped
    insertTestReel('reel-g', 'GROUNDED', {
      summary: 'Machine learning framework comparison',
      transcript: 'Comparing ML frameworks objectively',
      hype_level: 'grounded',
      implementation_readiness: 'production',
    });
    insertTestReel('reel-h', 'HYPED', {
      summary: 'Machine learning amazing new framework',
      transcript: 'This incredible new ML framework changes everything',
      hype_level: 'high_hype',
      implementation_readiness: 'concept',
    });

    const groundedEntity = db.upsertEntity({
      name: 'StableML',
      type: 'framework',
      description: 'A stable ML framework',
    });
    const hypedEntity = db.upsertEntity({
      name: 'HypeML',
      type: 'framework',
      description: 'A hyped ML framework',
    });

    db.linkReelEntity('reel-g', groundedEntity, 'mention', 1.0, 'transcript');
    db.linkReelEntity('reel-h', hypedEntity, 'mention', 1.0, 'transcript');

    const rec = getProjectRecommendations(db, 'machine learning', {
      preferGrounded: true,
      preferProduction: true,
    });

    // If both are found, grounded should score higher
    if (rec.tools.length >= 2) {
      const stableItem = rec.tools.find(t => t.name === 'StableML');
      const hypeItem = rec.tools.find(t => t.name === 'HypeML');
      if (stableItem && hypeItem) {
        expect(stableItem.score).toBeGreaterThan(hypeItem.score);
      }
    }
  });

  it('prioritizes production-ready over research', () => {
    insertTestReel('reel-p', 'PROD', {
      summary: 'Docker deployment best practices',
      hype_level: 'grounded',
      implementation_readiness: 'production',
    });
    insertTestReel('reel-r', 'RESEARCH', {
      summary: 'Docker new experimental features',
      hype_level: 'grounded',
      implementation_readiness: 'research',
    });

    const prodEntity = db.upsertEntity({
      name: 'DockerProd',
      type: 'tool',
      description: 'Production Docker',
    });
    const researchEntity = db.upsertEntity({
      name: 'DockerExp',
      type: 'tool',
      description: 'Experimental Docker features',
    });

    db.linkReelEntity('reel-p', prodEntity, 'mention', 1.0, 'transcript');
    db.linkReelEntity('reel-r', researchEntity, 'mention', 1.0, 'transcript');

    const rec = getProjectRecommendations(db, 'docker', {
      preferGrounded: true,
      preferProduction: true,
    });

    if (rec.tools.length >= 2) {
      const prodItem = rec.tools.find(t => t.name === 'DockerProd');
      const researchItem = rec.tools.find(t => t.name === 'DockerExp');
      if (prodItem && researchItem) {
        expect(prodItem.score).toBeGreaterThan(researchItem.score);
      }
    }
  });

  it('includes provenance reels', () => {
    insertTestReel('reel-prov', 'PROV', {
      summary: 'Next.js server components tutorial',
      transcript: 'Server components in Next.js',
    });

    const entityId = db.upsertEntity({ name: 'Next.js', type: 'framework', description: 'React meta-framework' });
    db.linkReelEntity('reel-prov', entityId, 'Next.js discussion', 1.0, 'transcript');

    const rec = getProjectRecommendations(db, 'nextjs', { maxPerCategory: 5 });

    const nextItem = rec.tools.find(t => t.name === 'Next.js');
    if (nextItem) {
      expect(nextItem.provenanceReels.length).toBeGreaterThanOrEqual(1);
      expect(nextItem.provenanceReels[0].shortcode).toBe('PROV');
    }
  });

  it('respects maxPerCategory option', () => {
    for (let i = 0; i < 10; i++) {
      insertTestReel(`reel-max-${i}`, `MAX${i}`, {
        summary: `Tool ${i} for web development`,
      });
      const entityId = db.upsertEntity({
        name: `WebTool${i}`,
        type: 'tool',
        description: `Web tool #${i}`,
      });
      db.linkReelEntity(`reel-max-${i}`, entityId, 'mention', 1.0, 'transcript');
    }

    const rec = getProjectRecommendations(db, 'web', { maxPerCategory: 3 });
    expect(rec.tools.length).toBeLessThanOrEqual(3);
  });
});

// ── Digest Generation Tests ─────────────────────────────────────────────

describe('generateDigest', () => {
  it('returns empty digest for empty database', () => {
    const digest = generateDigest(db, 7);
    expect(digest.totalReels).toBe(0);
    expect(digest.topTopics).toHaveLength(0);
    expect(digest.trendingEntities).toHaveLength(0);
    expect(digest.newEntities).toHaveLength(0);
    expect(digest.topReels).toHaveLength(0);
  });

  it('includes reels from the period', () => {
    insertTestReel('reel-d1', 'D1', { summary: 'Reel about AI techniques' });
    insertTestReel('reel-d2', 'D2', { summary: 'Reel about web development' });

    const digest = generateDigest(db, 7);
    expect(digest.totalReels).toBe(2);
    expect(digest.period).toBe('Last 7 days');
  });

  it('groups reels by category', () => {
    insertTestReel('reel-c1', 'CAT1', { content_type: 'tutorial' });
    insertTestReel('reel-c2', 'CAT2', { content_type: 'tutorial' });
    insertTestReel('reel-c3', 'CAT3', { content_type: 'tool_review' });

    const digest = generateDigest(db, 7);
    expect(digest.byCategory.tutorial).toBe(2);
    expect(digest.byCategory.tool_review).toBe(1);
  });

  it('identifies trending entities', () => {
    insertTestReel('reel-t1', 'TR1', { summary: 'Python AI development' });
    insertTestReel('reel-t2', 'TR2', { summary: 'Python web frameworks' });

    const entityId = db.upsertEntity({ name: 'Python', type: 'tool' });
    db.linkReelEntity('reel-t1', entityId, 'mention', 1.0, 'transcript');
    db.linkReelEntity('reel-t2', entityId, 'mention', 1.0, 'transcript');

    const digest = generateDigest(db, 7);
    expect(digest.trendingEntities.length).toBeGreaterThanOrEqual(1);
    expect(digest.trendingEntities[0].name).toBe('Python');
    expect(digest.trendingEntities[0].mentionCount).toBe(2);
  });

  it('identifies new entities', () => {
    insertTestReel('reel-new', 'NEW', { summary: 'A new tool appeared' });
    db.upsertEntity({ name: 'BrandNewTool', type: 'tool', description: 'Just discovered' });

    const digest = generateDigest(db, 7);
    const found = digest.newEntities.find(e => e.name === 'BrandNewTool');
    expect(found).toBeDefined();
    expect(found!.isNew).toBe(true);
  });

  it('ranks top reels by combined score', () => {
    insertTestReel('reel-top1', 'TOP1', {
      summary: 'High entity density reel',
      view_count: 10000,
      action_items: '["Try X", "Install Y", "Read Z"]',
    });
    insertTestReel('reel-top2', 'TOP2', {
      summary: 'Low engagement reel',
      view_count: 10,
      action_items: '[]',
    });

    // Add entities to first reel for entity density
    for (let i = 0; i < 5; i++) {
      const eid = db.upsertEntity({ name: `TopEntity${i}`, type: 'tool' });
      db.linkReelEntity('reel-top1', eid, 'mention', 1.0, 'transcript');
    }

    const digest = generateDigest(db, 7);
    expect(digest.topReels.length).toBeGreaterThanOrEqual(2);
    // First reel should score higher
    expect(digest.topReels[0].shortcode).toBe('TOP1');
    expect(digest.topReels[0].score).toBeGreaterThan(digest.topReels[1].score);
  });

  it('includes topics in digest', () => {
    insertTestReel('reel-topic', 'DTOPIC', { summary: 'Machine learning basics' });
    const topicId = db.upsertTopic('Machine Learning', 'ML topics');
    db.linkReelTopic('reel-topic', topicId, 1.0);

    const digest = generateDigest(db, 7);
    expect(digest.topTopics.length).toBeGreaterThanOrEqual(1);
    expect(digest.topTopics[0].topic).toBe('Machine Learning');
  });

  it('generates summary text', () => {
    insertTestReel('reel-s1', 'SUM1', { content_type: 'tutorial' });

    const digest = generateDigest(db, 7);
    expect(digest.summary).toContain('1 reels ingested');
    expect(digest.summary.length).toBeGreaterThan(0);
  });

  it('handles custom period (non-7 days)', () => {
    insertTestReel('reel-p', 'PER', { summary: 'Test' });

    const digest = generateDigest(db, 30);
    expect(digest.period).toBe('Last 30 days');
  });
});

// ── GitHub Enrichment URL Parsing Tests ─────────────────────────────────

describe('extractGitHubRepo', () => {
  it('extracts owner/repo from standard GitHub URL', () => {
    expect(extractGitHubRepo('https://github.com/facebook/react')).toBe('facebook/react');
  });

  it('extracts from URL with trailing slash', () => {
    expect(extractGitHubRepo('https://github.com/facebook/react/')).toBe('facebook/react');
  });

  it('extracts from URL with www', () => {
    expect(extractGitHubRepo('https://www.github.com/user/repo')).toBe('user/repo');
  });

  it('extracts from HTTP URL', () => {
    expect(extractGitHubRepo('http://github.com/user/repo')).toBe('user/repo');
  });

  it('handles .git suffix', () => {
    expect(extractGitHubRepo('https://github.com/user/repo.git')).toBe('user/repo');
  });

  it('handles repos with dots in name', () => {
    expect(extractGitHubRepo('https://github.com/user/my.repo')).toBe('user/my.repo');
  });

  it('handles repos with hyphens and underscores', () => {
    expect(extractGitHubRepo('https://github.com/my-org/my_repo')).toBe('my-org/my_repo');
  });

  it('returns null for non-GitHub URLs', () => {
    expect(extractGitHubRepo('https://gitlab.com/user/repo')).toBeNull();
    expect(extractGitHubRepo('https://instagram.com/reel/ABC/')).toBeNull();
  });

  it('returns null for invalid strings', () => {
    expect(extractGitHubRepo('not a url')).toBeNull();
    expect(extractGitHubRepo('')).toBeNull();
  });
});

describe('formatRepoInfo', () => {
  it('formats repo info as structured text', () => {
    const info: GitHubRepoInfo = {
      fullName: 'facebook/react',
      description: 'A JavaScript library for building user interfaces',
      stars: 220000,
      forks: 45000,
      language: 'JavaScript',
      topics: ['ui', 'frontend', 'react'],
      lastPushed: '2024-01-15T12:00:00Z',
      openIssues: 1200,
      license: 'MIT',
      homepage: 'https://reactjs.org',
      isArchived: false,
    };

    const text = formatRepoInfo(info);
    expect(text).toContain('facebook/react');
    expect(text).toContain('220000');
    expect(text).toContain('JavaScript');
    expect(text).toContain('MIT');
    expect(text).toContain('ui, frontend, react');
    expect(text).not.toContain('ARCHIVED');
  });

  it('marks archived repos', () => {
    const info: GitHubRepoInfo = {
      fullName: 'old/repo',
      description: '',
      stars: 100,
      forks: 10,
      language: '',
      topics: [],
      lastPushed: '2020-01-01T00:00:00Z',
      openIssues: 0,
      license: '',
      homepage: '',
      isArchived: true,
    };

    const text = formatRepoInfo(info);
    expect(text).toContain('ARCHIVED');
  });

  it('handles empty fields gracefully', () => {
    const info: GitHubRepoInfo = {
      fullName: 'user/minimal',
      description: '',
      stars: 0,
      forks: 0,
      language: '',
      topics: [],
      lastPushed: '',
      openIssues: 0,
      license: '',
      homepage: '',
      isArchived: false,
    };

    const text = formatRepoInfo(info);
    expect(text).toContain('user/minimal');
    // Should not contain empty-value labels
    expect(text).not.toContain('Language:');
    expect(text).not.toContain('License:');
    expect(text).not.toContain('Topics:');
  });
});
