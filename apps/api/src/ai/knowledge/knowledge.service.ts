import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../persistence';
import type { AiKnowledgeSegment, KnowledgeSearchHit } from './knowledge.types';

/**
 * `AI_KNOWLEDGE_FTS_CONFIG` is not a declared key in `src/common/config/env.schema.ts`.
 * There is exactly one curated corpus and it is written in Russian, so the text search
 * configuration is hardcoded rather than threaded through configuration for a choice
 * nothing in this deployment ever makes differently.
 */
const FTS_LANGUAGE = 'russian';

const FTS_INDEX_NAME = 'ai_documents_fts';

interface SearchRow {
  readonly id: string;
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly segment: AiKnowledgeSegment;
  readonly actions: string[];
}

/**
 * Lexical search over the curated knowledge corpus, indexed by `knowledge.indexer.ts`.
 *
 * There are no embeddings and no vector search here by deliberate decision (see the
 * `ai_documents_fts` migration comment in `20260920140000_ai_gateway`) -- the corpus is
 * small, curated and in one language, and `websearch_to_tsquery` with Russian morphology
 * is enough to find it.
 */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Prisma cannot declare an expression index (`schema.prisma` has no syntax for one),
   * so `ai_documents_fts` is created by hand in the migration and a later
   * `prisma migrate dev` does not know it exists -- it can be dropped and regenerated
   * without a diff ever mentioning it. This is the check that makes that loud: a cheap
   * `pg_indexes` lookup at startup, failing the boot instead of letting every query
   * after it silently fall back to a sequential scan.
   */
  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = ${FTS_INDEX_NAME}
      ) AS "present"
    `;
    if (!rows[0]?.present) {
      throw new Error(
        `Required index "${FTS_INDEX_NAME}" is missing from the database. It is a hand` +
          '-written expression index (migration 20260920140000_ai_gateway) that Prisma ' +
          'cannot declare in schema.prisma, so it does not come back from `prisma ' +
          'migrate dev` on its own -- re-apply that migration, or recreate the index by ' +
          'hand, before knowledge search can run.',
      );
    }
    this.logger.log(`Required index "${FTS_INDEX_NAME}" is present`);
  }

  /**
   * Ranked lexical search over the corpus, restricted to `segments`.
   *
   * `segments` is always supplied by the caller from the trusted session -- there is no
   * default and no widening inside this method. The generated SQL carries
   * `WHERE segment = ANY($segments)` unconditionally; nothing here reads a segment list
   * out of `query` or out of any model-authored argument, because there is no path from
   * either into this parameter. That absence of a path is the entire isolation
   * guarantee between the client, engineer and dispatcher segments (docs/knowledge/
   * README.md, "Три сегмента"): a caller that wants to widen access has to change the
   * trusted `segments` argument it passes in, which means changing the tool-dispatch
   * code, not anything a model can say in a message.
   *
   * Tries `websearch_to_tsquery` first (handles free-form phrasing, quoting and `-word`
   * exclusion the way a search box would); if that yields nothing -- a plausible outcome
   * for a short or unusual query -- retries once through `plainto_tsquery`, which is
   * more permissive about what counts as a token, before concluding "not found". Ranked
   * by `ts_rank_cd` over the same weighted `title`/`summary`/`body` expression the
   * `ai_documents_fts` GIN index is built on; the two must stay textually identical or
   * PostgreSQL will not use the index (see that migration's comment).
   */
  async search(
    query: string,
    segments: AiKnowledgeSegment[],
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    if (segments.length === 0 || limit <= 0) {
      return [];
    }
    const trimmedQuery = query.trim();
    if (trimmedQuery === '') {
      return [];
    }

    const primary = await this.searchWebsearch(trimmedQuery, segments, limit);
    if (primary.length > 0) {
      return primary;
    }
    return this.searchPlain(trimmedQuery, segments, limit);
  }

  private async searchWebsearch(
    query: string,
    segments: AiKnowledgeSegment[],
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>`
      SELECT
        id, slug, section, title, summary, body, segment, actions,
        ts_rank_cd(
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C'),
          websearch_to_tsquery(${FTS_LANGUAGE}, ${query})
        ) AS rank
      FROM ai_documents
      WHERE segment = ANY(${segments}::"AiKnowledgeSegment"[])
        AND (
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C')
        ) @@ websearch_to_tsquery(${FTS_LANGUAGE}, ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    return toHits(rows);
  }

  private async searchPlain(
    query: string,
    segments: AiKnowledgeSegment[],
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>`
      SELECT
        id, slug, section, title, summary, body, segment, actions,
        ts_rank_cd(
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C'),
          plainto_tsquery(${FTS_LANGUAGE}, ${query})
        ) AS rank
      FROM ai_documents
      WHERE segment = ANY(${segments}::"AiKnowledgeSegment"[])
        AND (
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C')
        ) @@ plainto_tsquery(${FTS_LANGUAGE}, ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    return toHits(rows);
  }
}

function toHits(rows: SearchRow[]): KnowledgeSearchHit[] {
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    section: row.section,
    title: row.title,
    summary: row.summary,
    body: row.body,
    segment: row.segment,
    actions: row.actions,
  }));
}
