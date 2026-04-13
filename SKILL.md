---
name: knowledge-engine
description: Personal AI Knowledge Engine - query your Instagram reel knowledge base
---

# Knowledge Engine

You have access to a personal knowledge base built from Instagram reels. The knowledge base contains structured extractions from tech/AI video content including entities (tools, libraries, models, companies, people), relationships between them, factual claims, topics, and action items.

## Available Tools

### ke_ingest
Ingest a new Instagram reel into the knowledge base.

**When to use:** The user shares an Instagram reel URL and wants to extract and store knowledge from it.

**Parameters:**
- `url` (required): Full Instagram reel URL (e.g., `https://www.instagram.com/reel/ABC123/`)

**Example:**
```
ke_ingest({ url: "https://www.instagram.com/reel/C1234XYZ/" })
```

**Returns:** Summary of extracted knowledge including content type, entities, facts, topics, and processing time.

### ke_search
Search across all ingested knowledge using full-text search.

**When to use:** The user asks about a topic, tool, concept, or anything that might be covered in previously ingested reels.

**Parameters:**
- `query` (required): Search terms
- `limit` (optional): Max results (default: 10)
- `category` (optional): Filter by content type - one of: `repo_recommendation`, `tutorial`, `news_update`, `tool_review`, `research_insight`, `workflow_tip`, `product_idea`, `engineering_trick`, `ai_technique`, `general`

**Example:**
```
ke_search({ query: "transformer attention mechanism", limit: 5 })
ke_search({ query: "langchain", category: "tutorial" })
```

**Returns:** Matching reels with summaries, authors, URLs, sentiment, hype level, and implementation readiness.

### ke_graph
Explore entity relationships in the knowledge graph.

**When to use:** The user asks how tools/libraries/concepts relate to each other, or wants to explore what is connected to a specific entity.

**Parameters:**
- `entity` (required): Entity name to look up (e.g., "LangChain", "GPT-4", "React")

**Example:**
```
ke_graph({ entity: "LangChain" })
```

**Returns:** The entity, all directly related entities, and the relationships between them (e.g., "recommends", "replaces", "integrates_with", "depends_on").

### ke_stats
Get statistics about the knowledge base.

**When to use:** The user asks how much knowledge has been ingested, or wants an overview of the knowledge base.

**Parameters:** None

**Example:**
```
ke_stats({})
```

**Returns:** Total counts of reels, entities, relationships, facts, and topics, plus breakdowns by content category and processing status.

## Knowledge Base Structure

Each ingested reel produces:
- **Summary**: One-paragraph description of the content
- **Content Type**: Classification (e.g., tutorial, tool_review, ai_technique)
- **Entities**: Named things mentioned (tools, libraries, models, people, companies)
- **Relationships**: How entities relate (recommends, replaces, integrates_with, etc.)
- **Facts**: Specific claims with confidence scores and sources
- **Topics**: High-level topic tags
- **Metadata**: Author, sentiment, hype level, implementation readiness, GitHub URLs

## Usage Guidelines

1. **Search first** before ingesting -- avoid duplicate processing.
2. Use **ke_graph** to answer "how does X relate to Y?" questions.
3. Use **ke_search** with category filters for specific content types.
4. When the user mentions an Instagram reel URL in conversation, consider offering to ingest it.
5. Summarize search results concisely -- the user does not need raw database fields.
