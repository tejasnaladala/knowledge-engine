// ── Source Type ───────────────────────────────────────────────────────────
//
// All content types the Knowledge Engine can ingest. This is the canonical
// SourceType enum used across the codebase.

export type SourceType =
  | 'instagram_reel'
  | 'youtube'
  | 'github_repo'
  | 'github_issue'
  | 'github_pr'
  | 'reddit_post'
  | 'twitter_post'
  | 'tiktok'
  | 'hacker_news'
  | 'arxiv_paper'
  | 'article'
  | 'plain_text';

// ── Reel Metadata from yt-dlp ──────────────────────────────────────────────

export interface ReelMetadata {
  author: string;
  authorId: string;
  title: string;
  description: string;
  duration: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  uploadDate: string;
  thumbnailUrl: string;
  hashtags: string[];
}

// ── Extraction Types ───────────────────────────────────────────────────────

export type ContentType =
  | 'repo_recommendation'
  | 'tutorial'
  | 'news_update'
  | 'tool_review'
  | 'research_insight'
  | 'workflow_tip'
  | 'product_idea'
  | 'engineering_trick'
  | 'ai_technique'
  | 'general';

export type EntityType =
  | 'repository'
  | 'tool'
  | 'model'
  | 'library'
  | 'framework'
  | 'paper'
  | 'company'
  | 'person'
  | 'technique'
  | 'workflow'
  | 'architecture'
  | 'product_idea'
  | 'benchmark'
  | 'trend';

export type RelationshipType =
  | 'mentions'
  | 'recommends'
  | 'improves'
  | 'replaces'
  | 'integrates_with'
  | 'depends_on'
  | 'similar_to'
  | 'relevant_for'
  | 'good_for'
  | 'not_good_for'
  | 'announced_by'
  | 'compared_against'
  | 'used_in';

export type Sentiment = 'positive' | 'negative' | 'neutral' | 'mixed';

export type HypeLevel = 'grounded' | 'moderate_hype' | 'high_hype';

export type ImplementationReadiness =
  | 'production'
  | 'beta'
  | 'alpha'
  | 'research'
  | 'concept';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
  aliases?: string[];
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: RelationshipType;
  description: string;
}

export interface ExtractedFact {
  claim: string;
  confidence: number;
  source: 'transcript' | 'caption' | 'ocr';
}

export interface ExtractedKnowledge {
  summary: string;
  topics: string[];
  contentType: ContentType;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  facts: ExtractedFact[];
  actionItems: string[];
  githubUrls: string[];
  sentiment: Sentiment;
  hypeLevel: HypeLevel;
  implementationReadiness: ImplementationReadiness;
  tags: string[];
}

export interface AnalysisInput {
  caption: string;
  transcript: string;
  ocrTexts: string[];
  metadata: ReelMetadata;
}

// ── Pipeline Types ─────────────────────────────────────────────────────────

export interface PipelineConfig {
  mediaDir: string;
  whisperModel?: string;
  maxOcrFrames?: number;
}

export interface ExtractionResult {
  url: string;
  shortcode: string;
  metadata: ReelMetadata;
  transcript: string;
  ocrTexts: string[];
  knowledge: ExtractedKnowledge;
  processingTimeMs: number;
}

// ── Storage Types ──────────────────────────────────────────────────────────

export interface StoredReel {
  id: string;
  url: string;
  shortcode: string;
  /** Source type for this content. Defaults to 'instagram_reel' for backwards compatibility. */
  source_type: SourceType;
  author: string;
  author_id: string;
  title: string;
  description: string;
  duration: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  upload_date: string;
  thumbnail_url: string;
  transcript: string;
  ocr_text: string;
  summary: string;
  content_type: ContentType;
  sentiment: Sentiment;
  hype_level: HypeLevel;
  implementation_readiness: ImplementationReadiness;
  github_urls: string;
  action_items: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredEntity {
  id: string;
  canonical_name: string;
  display_name: string;
  type: EntityType;
  description: string;
  aliases: string;
  first_seen: string;
  mention_count: number;
}

export interface KnowledgeStats {
  totalReels: number;
  totalEntities: number;
  totalRelationships: number;
  totalFacts: number;
  totalTopics: number;
  lastIngested: string | null;
  reelsByCategory: Record<string, number>;
  reelsByStatus: Record<string, number>;
}
