// ── GitHub Extractor ──────────────────────────────────────────────────────
//
// Extracts knowledge from GitHub repositories using the `gh` CLI.
// Fetches repo metadata via the GitHub API and README content,
// then analyzes the repo using an OpenClaw LLM call.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { analyzeWithPrompt, extractJsonFromText } from './llm-analyzer.js';
import type { ExtractedKnowledge } from '../types.js';

const execFileAsync = promisify(execFile);

const GH_CLI = '/opt/homebrew/bin/gh';

// ── GitHub repo data interface ───────────────────────────────────────────

export interface GitHubRepoData {
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  readme: string;
  stars: number;
  forks: number;
  language: string;
  topics: string[];
  license: string;
  lastPush: string;
  openIssues: number;
  isArchived: boolean;
  homepage: string;
  createdAt: string;
}

// ── Extraction ───────────────────────────────────────────────────────────

/**
 * Fetch GitHub repository metadata and README content using the `gh` CLI.
 *
 * Uses two API calls:
 * 1. `gh api repos/{owner}/{repo}` for metadata (stars, forks, language, etc.)
 * 2. `gh api repos/{owner}/{repo}/readme` with raw Accept header for README content
 */
export async function extractGitHubRepo(
  owner: string,
  repo: string,
): Promise<GitHubRepoData> {
  // Fetch repo metadata
  const { stdout: repoJson } = await execFileAsync(
    GH_CLI,
    ['api', `repos/${owner}/${repo}`],
    { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
  );

  const raw = JSON.parse(repoJson);

  // Fetch README content (raw text)
  let readme = '';
  try {
    const { stdout: readmeText } = await execFileAsync(
      GH_CLI,
      [
        'api',
        `repos/${owner}/${repo}/readme`,
        '-H', 'Accept: application/vnd.github.raw+json',
      ],
      { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
    );
    // Truncate to first 3000 chars to keep LLM context manageable
    readme = readmeText.slice(0, 3000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github-extractor] Could not fetch README for ${owner}/${repo}: ${msg}`);
    readme = '';
  }

  return {
    owner,
    repo,
    fullName: raw.full_name || `${owner}/${repo}`,
    description: raw.description || '',
    readme,
    stars: raw.stargazers_count || 0,
    forks: raw.forks_count || 0,
    language: raw.language || '',
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    license: raw.license?.spdx_id || raw.license?.name || '',
    lastPush: raw.pushed_at || '',
    openIssues: raw.open_issues_count || 0,
    isArchived: raw.archived || false,
    homepage: raw.homepage || '',
    createdAt: raw.created_at || '',
  };
}

// ── LLM Analysis ─────────────────────────────────────────────────────────

/**
 * Build a GitHub-repo-specific analysis prompt.
 */
function buildGitHubRepoPrompt(data: GitHubRepoData): string {
  return `You are a knowledge extraction engine analyzing a GitHub repository.

REPOSITORY: ${data.fullName}
DESCRIPTION: ${data.description || '(none)'}
LANGUAGE: ${data.language || '(unknown)'}
STARS: ${data.stars} | FORKS: ${data.forks} | OPEN ISSUES: ${data.openIssues}
LICENSE: ${data.license || '(none)'}
TOPICS: ${data.topics.join(', ') || '(none)'}
ARCHIVED: ${data.isArchived}
HOMEPAGE: ${data.homepage || '(none)'}
CREATED: ${data.createdAt}
LAST PUSHED: ${data.lastPush}

README (first 3000 chars):
${data.readme || '(no README available)'}

---

Analyze this GitHub repository and extract structured knowledge. Respond with a single JSON object (no markdown fences, no extra text) with EXACTLY these fields:

{
  "summary": "2-3 sentence summary of what this repository does and why it is useful",

  "topics": ["topic1", "topic2"],

  "contentType": "one of: repo_recommendation, tutorial, news_update, tool_review, research_insight, workflow_tip, product_idea, engineering_trick, ai_technique, general",

  "entities": [
    {
      "name": "Display Name",
      "type": "one of: repository, tool, model, library, framework, paper, company, person, technique, workflow, architecture, product_idea, benchmark, trend",
      "description": "Brief description of this entity and its relevance",
      "aliases": ["alternative names or abbreviations"]
    }
  ],

  "relationships": [
    {
      "source": "Entity Name A",
      "target": "Entity Name B",
      "type": "one of: mentions, recommends, improves, replaces, integrates_with, depends_on, similar_to, relevant_for, good_for, not_good_for, announced_by, compared_against, used_in",
      "description": "How these entities are related"
    }
  ],

  "facts": [
    {
      "claim": "A specific factual claim about this repository",
      "confidence": 0.9,
      "source": "caption"
    }
  ],

  "actionItems": ["Things to try, install, or explore with this repo"],

  "githubUrls": ["https://github.com/${data.fullName}"],

  "sentiment": "one of: positive, negative, neutral, mixed",

  "hypeLevel": "one of: grounded (factual/measured), moderate_hype (enthusiastic but reasonable), high_hype (strong promotion, possibly overstated)",

  "implementationReadiness": "one of: production (stable, widely used), beta (usable but evolving), alpha (early stage), research (academic/experimental), concept (idea only)",

  "tags": ["lowercase_tag1", "lowercase_tag2"]
}

RULES:
- Include the repository itself as an entity of type "repository"
- Extract any dependencies, similar projects, or alternative tools mentioned in the README
- Include the repo's GitHub URL in githubUrls
- Determine implementation readiness based on stars, activity, and README maturity signals
- Assess hype level objectively based on the repo description and README tone
- Tags should be lowercase with underscores for spaces
- Be thorough -- this data feeds a personal knowledge graph`;
}

/**
 * Analyze a GitHub repository using the OpenClaw LLM.
 * Takes structured repo data and returns extracted knowledge.
 */
export async function analyzeGitHubRepo(
  data: GitHubRepoData,
): Promise<ExtractedKnowledge> {
  const prompt = buildGitHubRepoPrompt(data);
  const sessionId = `ke-github-${data.owner}-${data.repo}-${Date.now()}`;

  return analyzeWithPrompt(prompt, sessionId);
}
