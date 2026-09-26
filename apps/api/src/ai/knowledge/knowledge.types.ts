import type { AiKnowledgeSegment } from '../../generated/prisma/enums';

export type { AiKnowledgeSegment };

/**
 * The three segment directories under `docs/knowledge/` and the only values the
 * front-matter `segment` key may hold (docs/knowledge/README.md, "Три сегмента"). A
 * plain tuple rather than `Object.values(AiKnowledgeSegment)`: it is what
 * `knowledge.indexer.ts` iterates to walk the corpus, and keeping it a literal keeps
 * that walk order stable and readable at the call site.
 */
export const KNOWLEDGE_SEGMENTS: readonly AiKnowledgeSegment[] = [
  'client',
  'engineer',
  'dispatcher',
];

/**
 * One `##`-section of an article, already carrying the front-matter it inherits -- the
 * exact shape `knowledge.indexer.ts` upserts by `(slug, section)` into `ai_documents`.
 */
export interface KnowledgeSection {
  /** The front-matter `id` (`disp-01-day-shape`), stable per article, global across
   *  segments because the id already carries its segment's prefix. */
  readonly slug: string;
  /** The `##` heading text this section was split on. */
  readonly section: string;
  readonly segment: AiKnowledgeSegment;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly actions: readonly string[];
  /** Unix seconds parsed from the front-matter `updated: YYYY-MM-DD` date -- the last
   *  day the article's facts were checked against the code, not when the indexer ran. */
  readonly updatedAt: number;
  /** Deterministic fingerprint of every column above; see `sectionChecksum`. */
  readonly checksum: string;
  /** Repository-relative path, e.g. `docs/knowledge/dispatcher/01-day-shape.md`. */
  readonly sourcePath: string;
}

/** One row `KnowledgeService.search` returns to a tool -- see its doc comment for the
 *  isolation guarantee `segment` here depends on. */
export interface KnowledgeSearchHit {
  readonly id: string;
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly segment: AiKnowledgeSegment;
  readonly actions: string[];
}

/** Result of one `indexKnowledge` pass, logged by the caller. */
export interface KnowledgeIndexSummary {
  readonly filesRead: number;
  readonly sectionsSeen: number;
  readonly sectionsWritten: number;
  readonly sectionsUnchanged: number;
  readonly sectionsDeleted: number;
}
