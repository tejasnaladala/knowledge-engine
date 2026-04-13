// ── Simple Embedding Generation ──────────────────────────────────────────
//
// Local embedding via word trigram hashing -- no LLM calls needed.
// Produces a 256-dimension vector suitable for cosine similarity search.

const EMBEDDING_DIM = 256;

/**
 * Generate a simple 256-dimension embedding from text using trigram hashing.
 *
 * Strategy:
 * 1. Tokenize text into lowercase words
 * 2. Generate character trigrams from each word
 * 3. Hash each trigram to a dimension index
 * 4. Accumulate weights (TF-like frequency)
 * 5. L2-normalize the resulting vector
 *
 * This produces consistent embeddings: same text always yields the same vector.
 */
export function generateSimpleEmbedding(text: string): number[] {
  const vector = new Float64Array(EMBEDDING_DIM);

  // Tokenize: lowercase, split on non-alphanumeric, filter empty
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  if (words.length === 0) {
    return Array.from(vector);
  }

  // Process each word
  for (const word of words) {
    // Word-level hash: spread the word across a few dimensions
    const wordHash = hashString(word);
    vector[Math.abs(wordHash) % EMBEDDING_DIM] += 1.0;

    // Character trigram hashing for finer-grained similarity
    const padded = `_${word}_`;
    for (let i = 0; i < padded.length - 2; i++) {
      const trigram = padded.slice(i, i + 3);
      const h = hashString(trigram);
      const idx = Math.abs(h) % EMBEDDING_DIM;
      // Use sign of secondary hash for positive/negative contribution
      const sign = hashString(trigram + 'salt') % 2 === 0 ? 1 : -1;
      vector[idx] += sign * 0.5;
    }
  }

  // Bigram word pairs for phrase-level signal
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    const h = hashString(bigram);
    const idx = Math.abs(h) % EMBEDDING_DIM;
    vector[idx] += 0.75;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vector[i] /= norm;
    }
  }

  return Array.from(vector);
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Assumes both vectors are L2-normalized (so dot product = cosine).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ── Hash utility ─────────────────────────────────────────────────────────

/**
 * Simple deterministic string hash (DJB2 variant).
 * Returns a 32-bit integer.
 */
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}
