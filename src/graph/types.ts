// ── Entity Type Constants ─────────────────────────────────────────────────

import type { EntityType, RelationshipType } from '../types.js';

export const ENTITY_TYPES: EntityType[] = [
  'repository',
  'tool',
  'model',
  'library',
  'framework',
  'paper',
  'company',
  'person',
  'technique',
  'workflow',
  'architecture',
  'product_idea',
  'benchmark',
  'trend',
];

// ── Relationship Type Constants ──────────────────────────────────────────

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'mentions',
  'recommends',
  'improves',
  'replaces',
  'integrates_with',
  'depends_on',
  'similar_to',
  'relevant_for',
  'good_for',
  'not_good_for',
  'announced_by',
  'compared_against',
  'used_in',
];

// ── Normalization helpers ────────────────────────────────────────────────

/**
 * Map of common aliases / display names to their canonical EntityType.
 * Keys are lowercased for matching.
 */
const ENTITY_TYPE_ALIASES: Record<string, EntityType> = {
  'github repo': 'repository',
  'github repository': 'repository',
  repo: 'repository',
  lib: 'library',
  pkg: 'library',
  package: 'library',
  sdk: 'library',
  app: 'tool',
  application: 'tool',
  cli: 'tool',
  service: 'tool',
  saas: 'tool',
  llm: 'model',
  'language model': 'model',
  'ai model': 'model',
  'neural network': 'model',
  org: 'company',
  organization: 'company',
  startup: 'company',
  author: 'person',
  creator: 'person',
  developer: 'person',
  researcher: 'person',
  method: 'technique',
  algorithm: 'technique',
  approach: 'technique',
  pattern: 'architecture',
  design: 'architecture',
  idea: 'product_idea',
  concept: 'product_idea',
  test: 'benchmark',
  evaluation: 'benchmark',
  movement: 'trend',
};

/**
 * Normalize a raw entity type string to a canonical EntityType.
 * Handles common aliases like "GitHub Repo" -> "repository".
 * Returns the original type if already valid, or falls back to 'tool'.
 */
export function normalizeEntityType(raw: string): EntityType {
  const lower = raw.toLowerCase().trim();

  // Direct match
  if ((ENTITY_TYPES as string[]).includes(lower)) {
    return lower as EntityType;
  }

  // Alias match
  const alias = ENTITY_TYPE_ALIASES[lower];
  if (alias) {
    return alias;
  }

  // Partial match -- check if the input contains a known type
  for (const type of ENTITY_TYPES) {
    if (lower.includes(type)) {
      return type;
    }
  }

  return 'tool';
}
