import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KnowledgeDB } from '../storage/db.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export interface GitHubRepoInfo {
  fullName: string;
  description: string;
  stars: number;
  forks: number;
  language: string;
  topics: string[];
  lastPushed: string;
  openIssues: number;
  license: string;
  homepage: string;
  isArchived: boolean;
}

// ── GitHub URL parsing ──────────────────────────────────────────────────

const GITHUB_REPO_RE =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?/;

/**
 * Extract the owner/repo path from a GitHub URL.
 * Returns null if the URL is not a valid GitHub repo URL.
 */
export function extractGitHubRepo(url: string): string | null {
  const match = url.match(GITHUB_REPO_RE);
  if (!match) return null;

  // Clean up trailing segments that aren't part of owner/repo
  let repo = match[1];
  // Remove .git suffix
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  return repo;
}

// ── Single repo enrichment ──────────────────────────────────────────────

/**
 * Fetch metadata for a GitHub repository using the `gh` CLI.
 *
 * Requires `gh` to be installed and authenticated.
 * Handles rate limits, missing repos, and private repos gracefully.
 */
export async function enrichGitHubRepo(repoUrl: string): Promise<GitHubRepoInfo | null> {
  const repoPath = extractGitHubRepo(repoUrl);
  if (!repoPath) return null;

  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${repoPath}`,
      '--jq',
      [
        '{',
        '  fullName: .full_name,',
        '  description: (.description // ""),',
        '  stars: .stargazers_count,',
        '  forks: .forks_count,',
        '  language: (.language // ""),',
        '  topics: (.topics // []),',
        '  lastPushed: .pushed_at,',
        '  openIssues: .open_issues_count,',
        '  license: (.license.spdx_id // ""),',
        '  homepage: (.homepage // ""),',
        '  isArchived: .archived',
        '}',
      ].join('\n'),
    ], {
      timeout: 15000,
      maxBuffer: 1024 * 100,
    });

    const data = JSON.parse(stdout.trim()) as GitHubRepoInfo;
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // Handle known error cases gracefully
    if (msg.includes('404') || msg.includes('Not Found')) {
      // Repo doesn't exist or is private
      return null;
    }
    if (msg.includes('403') || msg.includes('rate limit')) {
      // Rate limited -- caller should back off
      throw new Error(`GitHub API rate limit hit for ${repoPath}`);
    }
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      // gh CLI not installed
      throw new Error(
        'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
      );
    }

    // Unknown error
    return null;
  }
}

// ── Format enrichment data ──────────────────────────────────────────────

/**
 * Format GitHubRepoInfo as structured text for storage in entity description.
 */
export function formatRepoInfo(info: GitHubRepoInfo): string {
  const lines = [
    `GitHub: ${info.fullName}`,
    info.description ? `Description: ${info.description}` : '',
    `Stars: ${info.stars} | Forks: ${info.forks} | Issues: ${info.openIssues}`,
    info.language ? `Language: ${info.language}` : '',
    info.topics.length > 0 ? `Topics: ${info.topics.join(', ')}` : '',
    info.license ? `License: ${info.license}` : '',
    info.homepage ? `Homepage: ${info.homepage}` : '',
    info.isArchived ? 'Status: ARCHIVED' : '',
    `Last pushed: ${info.lastPushed}`,
  ];

  return lines.filter(l => l.length > 0).join('\n');
}

// ── Batch enrichment ────────────────────────────────────────────────────

/**
 * Find all entities of type 'repository' in the database, extract GitHub
 * URLs from associated reels, and enrich each entity with GitHub metadata.
 *
 * Updates the entity description field with structured repo info.
 *
 * @returns Number of entities enriched.
 */
export async function enrichAllGitHubEntities(
  db: KnowledgeDB,
  opts?: { logger?: { info: (msg: string) => void; warn: (msg: string) => void } },
): Promise<number> {
  const log = opts?.logger ?? {
    info: console.log,
    warn: console.warn,
  };

  // Find all repository entities
  const repoEntities = db.getEntitiesByType('repository', 100);
  let enrichedCount = 0;

  for (const entity of repoEntities) {
    // Find GitHub URLs from reels linked to this entity
    const reelLinks = db.raw.prepare(`
      SELECT DISTINCT r.github_urls
      FROM reel_entities re
      JOIN reels r ON r.id = re.reel_id
      WHERE re.entity_id = ?
    `).all(entity.id) as Array<{ github_urls: string }>;

    // Collect all GitHub URLs
    const githubUrls: string[] = [];
    for (const link of reelLinks) {
      try {
        const urls = JSON.parse(link.github_urls) as string[];
        githubUrls.push(...urls);
      } catch {
        // Invalid JSON -- skip
      }
    }

    // Also check entity description for GitHub URLs
    const descMatch = entity.description.match(GITHUB_REPO_RE);
    if (descMatch) {
      githubUrls.push(descMatch[0]);
    }

    // Try to match entity name to a GitHub URL
    const matchingUrl = githubUrls.find(url => {
      const repo = extractGitHubRepo(url);
      if (!repo) return false;
      const repoName = repo.split('/')[1]?.toLowerCase() ?? '';
      return (
        repoName === entity.canonical_name ||
        entity.canonical_name.includes(repoName) ||
        repoName.includes(entity.canonical_name)
      );
    }) ?? githubUrls[0];

    if (!matchingUrl) {
      continue;
    }

    try {
      const info = await enrichGitHubRepo(matchingUrl);
      if (!info) {
        log.warn(`[enricher] Could not fetch info for ${matchingUrl}`);
        continue;
      }

      // Update entity description with enriched data
      const enrichedDescription = formatRepoInfo(info);
      db.raw.prepare(`
        UPDATE entities
        SET description = ?
        WHERE id = ?
      `).run(enrichedDescription, entity.id);

      log.info(`[enricher] Enriched: ${entity.display_name} (${info.stars} stars)`);
      enrichedCount++;

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('rate limit')) {
        log.warn('[enricher] Rate limit hit -- stopping enrichment');
        break;
      }
      log.warn(`[enricher] Error enriching ${entity.display_name}: ${msg}`);
    }
  }

  return enrichedCount;
}
