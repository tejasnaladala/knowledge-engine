import type { KnowledgeDB } from './db.js';
import { cosineSimilarity } from './embeddings.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  reelId: string;
  similarity: number;
}

export interface StoredEmbeddingRow {
  id: string;
  reel_id: string;
  embedding: string; // JSON-encoded float array
}

// ── Store embedding ──────────────────────────────────────────────────────

/**
 * Store an embedding vector for a reel.
 * Uses INSERT OR REPLACE to update if one already exists for the reel.
 */
export function storeEmbedding(
  db: KnowledgeDB,
  reelId: string,
  embedding: number[],
): void {
  db.storeEmbedding(reelId, embedding);
}

// ── Vector search ────────────────────────────────────────────────────────

/**
 * Search for similar reels by computing cosine similarity against all stored embeddings.
 * Returns results sorted by similarity (descending), limited to `limit` results.
 *
 * Since we store embeddings in a regular SQLite table (not a vector index),
 * similarity is computed in JavaScript. This is fine for small-to-medium
 * collections (< 100k reels).
 */
export function searchByVector(
  db: KnowledgeDB,
  queryEmbedding: number[],
  limit: number = 10,
): VectorSearchResult[] {
  const allEmbeddings = db.getAllEmbeddings();

  const results: VectorSearchResult[] = [];

  for (const row of allEmbeddings) {
    const storedEmbedding = JSON.parse(row.embedding) as number[];
    const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

    results.push({
      reelId: row.reel_id,
      similarity,
    });
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}
