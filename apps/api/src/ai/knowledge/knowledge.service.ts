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
  readonly sourcePath: string;
  readonly updatedAt: bigint;
  readonly checksum: string;
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
   * Three stages, tried in order, each only run when the one before it found nothing:
   *
   *   1. `websearch_to_tsquery` -- handles free-form phrasing, quoting and `-word`
   *      exclusion the way a search box would.
   *   2. `plainto_tsquery` -- more permissive about what counts as a token than stage 1;
   *      it rescues a query stage 1 rejected as a syntax error (e.g. a lone `-word`), but
   *      combines terms with AND exactly like stage 1 does, so it does not help a long
   *      question that no single document contains every word of.
   *   3. The same lexemes as stage 2, combined with OR instead of AND (`plainto_tsquery`'s
   *      own text form has its `&` connectors replaced with `|`, in SQL, so there is no
   *      second tokenizer to disagree with Postgres's own and no string-built query to
   *      inject through). This is the stage that turns a natural-language question --
   *      several words, only some of which any single article actually contains -- into a
   *      match at all.
   *
   * Stages 1 and 2 stay first, and stay AND, so a short precise query keeps getting its
   * single precise document rather than being buried under everything that shares one
   * common word with it; stage 3 is deliberately the widening fallback of last resort, not
   * the default, and `ts_rank_cd` is what still keeps the best-matching document on top
   * once stage 3 admits looser matches. Do not delete stage 1 or 2 to "simplify" this to
   * just the OR stage: that would trade every precise query's precision for the recall
   * only a handful of long questions need. All three rank by `ts_rank_cd` over the same
   * weighted `title`/`summary`/`body` expression the `ai_documents_fts` GIN index is built
   * on; that expression must stay textually identical in every stage and in the index
   * definition, or PostgreSQL will not use the index (see that migration's comment).
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
    const plain = await this.searchPlain(trimmedQuery, segments, limit);
    if (plain.length > 0) {
      return plain;
    }
    return this.searchOr(trimmedQuery, segments, limit);
  }

  private async searchWebsearch(
    query: string,
    segments: AiKnowledgeSegment[],
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>`
      SELECT
        id, slug, section, title, summary, body, segment, actions,
        source_path AS "sourcePath", updated_at AS "updatedAt", checksum,
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
        source_path AS "sourcePath", updated_at AS "updatedAt", checksum,
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

  /**
   * Stage 3: `plainto_tsquery`'s own lexemes, ANDed connectors rewritten to OR in SQL
   * (`replace(..., '&', '|')`) rather than by tokenising `query` a second time here --
   * whatever Postgres decided counts as a term and how it stems it is exactly what this
   * stage searches with, so there is no place for a second opinion about stemming to
   * disagree with stage 2, and no user-authored string is ever spliced into the query
   * text itself. See `search()`'s own doc comment for why this stage exists at all and
   * why it runs last.
   */
  private async searchOr(
    query: string,
    segments: AiKnowledgeSegment[],
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>`
      WITH q AS (
        SELECT CAST(
          replace(CAST(plainto_tsquery(${FTS_LANGUAGE}, ${query}) AS text), '&', '|')
          AS tsquery
        ) AS tq
      )
      SELECT
        id, slug, section, title, summary, body, segment, actions,
        source_path AS "sourcePath", updated_at AS "updatedAt", checksum,
        ts_rank_cd(
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C'),
          q.tq
        ) AS rank
      FROM ai_documents, q
      WHERE segment = ANY(${segments}::"AiKnowledgeSegment"[])
        AND (
          setweight(to_tsvector(${FTS_LANGUAGE}, title), 'A') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, summary), 'B') ||
          setweight(to_tsvector(${FTS_LANGUAGE}, body), 'C')
        ) @@ q.tq
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
    sourcePath: row.sourcePath,
    updatedAt: Number(row.updatedAt),
    checksum: row.checksum,
  }));
}
