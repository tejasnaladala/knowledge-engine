// ── ArXiv Paper Extractor ─────────────────────────────────────────────────
//
// Extracts knowledge from arXiv papers using the arXiv API.
// Fetches paper metadata (title, authors, abstract, categories) from
// the XML API, then analyzes the paper using an OpenClaw LLM call.

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ExtractedKnowledge } from '../types.js';
import { analyzeWithPrompt } from './llm-analyzer.js';

const execFileAsync = promisify(execFile);

// ── ArXiv paper data interface ───────────────────────────────────────────

export interface ArxivPaperData {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  publishDate: string;
  pdfUrl: string;
}

// ── XML parsing helpers ──────────────────────────────────────────────────

/**
 * Extract text content from an XML tag. Simple regex-based extraction
 * that works for the arXiv Atom feed format without requiring an XML parser.
 */
function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Extract all occurrences of an XML tag.
 */
function extractAllXmlTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * Extract attribute values from XML tags matching a pattern.
 */
function extractXmlAttributes(xml: string, tag: string, attr: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*\\/?>`, 'gi');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

// ── Extraction ───────────────────────────────────────────────────────────

/**
 * Fetch arXiv paper metadata from the arXiv API.
 *
 * Uses the Atom feed API at:
 *   http://export.arxiv.org/api/query?id_list={arxivId}
 *
 * @param arxivId - The arXiv paper ID (e.g., "2301.12345" or "2301.12345v2")
 */
export async function extractArxivPaper(arxivId: string): Promise<ArxivPaperData> {
  // Strip version suffix for the API query (it returns the latest by default)
  const cleanId = arxivId.replace(/v\d+$/, '');

  const apiUrl = `http://export.arxiv.org/api/query?id_list=${cleanId}`;

  const { stdout: xml } = await execFileAsync(
    'curl',
    [
      '-sL',
      '--max-time', '30',
      apiUrl,
    ],
    { timeout: 45_000, maxBuffer: 5 * 1024 * 1024 },
  );

  // Extract the <entry> block (there should be exactly one)
  const entryXml = extractXmlTag(xml, 'entry');
  if (!entryXml) {
    throw new Error(`No entry found in arXiv API response for ID: ${arxivId}`);
  }

  // Parse title -- arXiv titles can have newlines and extra whitespace
  const rawTitle = extractXmlTag(entryXml, 'title');
  const title = rawTitle.replace(/\s+/g, ' ').trim();

  // Parse authors -- each <author> has a <name> child
  const authorEntries = extractAllXmlTags(entryXml, 'author');
  const authors = authorEntries.map(authorXml => {
    const name = extractXmlTag(authorXml, 'name');
    return name || 'Unknown';
  });

  // Parse abstract (called "summary" in the Atom feed)
  const rawAbstract = extractXmlTag(entryXml, 'summary');
  const abstract = rawAbstract.replace(/\s+/g, ' ').trim();

  // Parse categories from <category> tags
  const categories = extractXmlAttributes(entryXml, 'category', 'term');

  // Parse published date
  const publishDate = extractXmlTag(entryXml, 'published');

  // Build PDF URL
  const pdfUrl = `https://arxiv.org/pdf/${cleanId}`;

  return {
    arxivId: cleanId,
    title,
    authors,
    abstract,
    categories,
    publishDate,
    pdfUrl,
  };
}

// ── LLM Analysis ─────────────────────────────────────────────────────────

/**
 * Build an arXiv-paper-specific analysis prompt.
 */
function buildArxivPrompt(data: ArxivPaperData): string {
  return `You are a knowledge extraction engine analyzing an academic research paper from arXiv.

PAPER: ${data.title}
AUTHORS: ${data.authors.join(', ')}
ARXIV ID: ${data.arxivId}
CATEGORIES: ${data.categories.join(', ')}
PUBLISHED: ${data.publishDate}
PDF: ${data.pdfUrl}

ABSTRACT:
${data.abstract}

---

Analyze this research paper and extract structured knowledge. Respond with a single JSON object (no markdown fences, no extra text) with EXACTLY these fields:

{
  "summary": "2-3 sentence summary of what this paper contributes and its significance",

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
      "claim": "A specific factual claim from the paper abstract",
      "confidence": 0.9,
      "source": "caption"
    }
  ],

  "actionItems": ["Practical applications or things to explore based on this research"],

  "githubUrls": ["any GitHub URLs mentioned (code repositories for the paper)"],

  "sentiment": "one of: positive, negative, neutral, mixed",

  "hypeLevel": "one of: grounded (factual/measured), moderate_hype (enthusiastic but reasonable), high_hype (strong promotion, possibly overstated)",

  "implementationReadiness": "one of: production (stable, widely used), beta (usable but evolving), alpha (early stage), research (academic/experimental), concept (idea only)",

  "tags": ["lowercase_tag1", "lowercase_tag2"]
}

RULES:
- The paper itself should be an entity of type "paper"
- All named authors should be entities of type "person"
- Extract any models, techniques, benchmarks, or datasets mentioned in the abstract
- The contentType for papers is typically "research_insight" or "ai_technique"
- Implementation readiness for papers is typically "research" unless they describe production systems
- Sentiment should reflect the paper's own claims about its results
- Be thorough -- this data feeds a personal knowledge graph
- Tags should be lowercase with underscores for spaces
- Include the arXiv categories as topics`;
}

/**
 * Analyze an arXiv paper using the OpenClaw LLM.
 * Takes structured paper data and returns extracted knowledge.
 */
export async function analyzeArxivPaper(
  data: ArxivPaperData,
): Promise<ExtractedKnowledge> {
  const prompt = buildArxivPrompt(data);
  const sessionId = `ke-arxiv-${data.arxivId.replace(/\./g, '-')}-${Date.now()}`;

  return analyzeWithPrompt(prompt, sessionId);
}
