---
name: knowledge-engine
description: Query a personal knowledge base built from saved videos, repos, papers, and articles
---

# Knowledge Engine

You have access to a personal knowledge base built from content the user saved across
many platforms: Instagram/YouTube/TikTok videos, GitHub repos, GitHub issues and PRs,
Reddit posts, Hacker News threads, arXiv papers, Twitter/X posts, and any web article.
Each source is reduced to structured knowledge: entities (tools, libraries, models,
companies, people), relationships between them, factual claims with confidence and
provenance, topics, and metadata like sentiment, hype level, and implementation readiness.

## Available Tools

### ke_ingest
Ingest content from any URL into the knowledge base.

**When to use:** The user shares a URL (any platform) and wants its knowledge extracted and stored.

**Parameters:**
- `url` (required): Any supported URL. The engine detects the source type and routes it to the right extraction pipeline.

**Example:**
```
ke_ingest({ url: "https://github.com/openai/whisper" })
ke_ingest({ url: "https://arxiv.org/abs/1706.03762" })
```

**Returns:** Extracted knowledge: source type, content type, entities, facts, topics, and processing time.

### ke_search
Search across all ingested knowledge using full-text search.

**When to use:** The user asks about a topic, tool, or concept that might be covered in previously ingested content.

**Parameters:**
- `query` (required): Search terms
- `limit` (optional): Max results (default: 10)
- `category` (optional): Filter by content type - one of: `repo_recommendation`, `tutorial`, `news_update`, `tool_review`, `research_insight`, `workflow_tip`, `product_idea`, `engineering_trick`, `ai_technique`, `general`

**Example:**
```
ke_search({ query: "transformer attention mechanism", limit: 5 })
ke_search({ query: "langchain", category: "tutorial" })
```

**Returns:** Matching sources with summaries, authors, URLs, sentiment, hype level, and implementation readiness.

### ke_graph
Explore entity relationships in the knowledge graph.

**When to use:** The user asks how tools, libraries, or concepts relate, or wants to explore what connects to a specific entity.

**Parameters:**
- `entity` (required): Entity name to look up (e.g., "LangChain", "GPT-4", "React")

**Example:**
```
ke_graph({ entity: "LangChain" })
```

**Returns:** The entity, all directly related entities, and the relationships between them (e.g., `recommends`, `replaces`, `integrates_with`, `depends_on`).

### ke_recommend
Project-mode recommendations: rank everything the user saved against a project description.

**When to use:** The user describes something they want to build and wants relevant repos, tools, and techniques from their own saved content.

**Parameters:**
- `description` (required): What the user is building.

**Example:**
```
ke_recommend({ description: "real-time collaborative editor with AI suggestions" })
```

**Returns:** Ranked repos, tools, techniques, and workflows, each linked back to the source where the user first saw it.

### ke_digest
Generate a digest of recent ingestions over a time window.

**When to use:** The user wants a periodic summary of what they have saved lately.

**Parameters:**
- `days` (optional): Look-back window in days (default: 7).

**Returns:** Grouped summary of recent content, top entities, and trending topics.

### ke_stats
Get statistics about the knowledge base.

**When to use:** The user asks how much has been ingested or wants an overview.

**Parameters:** None

**Returns:** Counts of sources, entities, relationships, facts, and topics, with breakdowns by content category and processing status.

## Knowledge Base Structure

Each ingested source produces:
- **Summary**: One-paragraph description of the content
- **Content Type**: Classification (e.g., tutorial, tool_review, ai_technique)
- **Entities**: Named things mentioned (tools, libraries, models, people, companies)
- **Relationships**: How entities relate (recommends, replaces, integrates_with, etc.)
- **Facts**: Specific claims with confidence scores and sources
- **Topics**: High-level topic tags
- **Metadata**: Author, sentiment, hype level, implementation readiness, GitHub URLs

## Usage Guidelines

1. **Search first** before ingesting to avoid duplicate processing.
2. Use **ke_graph** to answer "how does X relate to Y?" questions.
3. Use **ke_search** with category filters for specific content types.
4. When the user mentions a content URL in conversation, consider offering to ingest it.
5. Summarize results concisely. The user does not need raw database fields.
