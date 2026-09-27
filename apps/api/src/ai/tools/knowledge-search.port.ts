import type { AiKnowledgeSegment } from '../../generated/prisma/client';

/** One curated document row, as `KnowledgeService.search` (owned by `src/ai/knowledge/`)
 *  returns it -- this file only consumes that shape, it does not implement it. */
export interface KnowledgeSearchResult {
  readonly id: string;
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly segment: AiKnowledgeSegment;
  readonly actions: string[];
  /** Source metadata for citations; legacy ports may omit it rather than invent a version. */
  readonly sourcePath?: string;
  readonly updatedAt?: number;
  readonly checksum?: string;
}

/**
 * The retrieval step the `search_documentation` tool calls.
 *
 * Declared here as a DI token rather than imported from `src/ai/knowledge/` because that
 * module is a parallel piece of work (see this change's own task boundary); whichever
 * module provides the real `KnowledgeService` binds it to this token in `AiModule`. Until
 * that binding exists, `search_documentation` refuses honestly instead of crashing --
 * see `NoopKnowledgeSearchPort` below, the same pattern `NoopToolDispatcher` uses for the
 * tool-dispatcher seam.
 */
export abstract class KnowledgeSearchPort {
  abstract search(
    query: string,
    segments: readonly AiKnowledgeSegment[],
    limit: number,
  ): Promise<readonly KnowledgeSearchResult[]>;
}

export class NoopKnowledgeSearchPort extends KnowledgeSearchPort {
  async search(): Promise<readonly KnowledgeSearchResult[]> {
    await Promise.resolve();
    return [];
  }
}
