import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { defaultCorpusRoot, indexKnowledge } from '../../src/ai/knowledge/knowledge.indexer';
import { KnowledgeService } from '../../src/ai/knowledge/knowledge.service';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/persistence';
import { createTestClient, databaseUrl } from '../support/database';

/**
 * Indexes the real `docs/knowledge/**` corpus into a real PostgreSQL and exercises
 * lexical search against it -- segment isolation, Russian morphology and the query plan
 * all depend on genuine `tsvector`/GIN behaviour that no fake could stand in for.
 *
 * No app boot: `KnowledgeService` only needs a Prisma client, so this follows the same
 * direct-construction convention `test/integration/ai-run.test.ts` uses for
 * `BudgetService` rather than paying for `NestFactory.createApplicationContext`.
 *
 * The corpus is indexed once into the real table and left there afterwards -- this is
 * the genuine index the running application serves from, not a disposable fixture, so
 * there is nothing to clean up.
 */
describe('knowledge corpus and search', () => {
  let prisma: PrismaClient;
  let service: KnowledgeService;

  before(async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      'Use an isolated TEST_DATABASE_URL for knowledge integration tests',
    );
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    service = new KnowledgeService(prisma as unknown as PrismaService);
    await service.onModuleInit();
    await indexKnowledge(prisma, defaultCorpusRoot());
  });

  it('indexes every article of the real corpus into ai_documents', async () => {
    const count = await prisma.aiDocument.count();
    // 37 articles, several `##` sections each -- a loose floor that only breaks if the
    // corpus somehow stopped indexing almost entirely, not on ordinary edits to it.
    assert.ok(count > 60, `expected many indexed sections, got ${count}`);
  });

  it('re-indexing an unchanged corpus writes and deletes nothing', async () => {
    const summary = await indexKnowledge(prisma, defaultCorpusRoot());
    assert.equal(summary.sectionsWritten, 0);
    assert.equal(summary.sectionsDeleted, 0);
    assert.equal(summary.sectionsUnchanged, summary.sectionsSeen);
  });

  it('a client-segment query never returns an engineer or dispatcher section', async () => {
    const hits = await service.search('заявка', ['client'], 20);
    assert.ok(hits.length > 0, 'expected at least one client hit for "заявка"');
    for (const hit of hits) {
      assert.equal(hit.segment, 'client');
    }
  });

  it('a dispatcher-segment query can reach all three segments', async () => {
    const hits = await service.search('заявка', ['client', 'engineer', 'dispatcher'], 50);
    const segmentsSeen = new Set(hits.map((hit) => hit.segment));
    assert.ok(segmentsSeen.has('client'), 'expected a client hit');
    assert.ok(segmentsSeen.has('engineer'), 'expected an engineer hit');
    assert.ok(segmentsSeen.has('dispatcher'), 'expected a dispatcher hit');
  });

  it('an empty segments list returns nothing, regardless of the query', async () => {
    const hits = await service.search('заявка', [], 20);
    assert.deepEqual(hits, []);
  });

  it('Russian morphology matches the query form to a different word form in the text', async () => {
    // The query is the nominative "оборудование"; the corpus (engineer/09) only has the
    // genitive "оборудования" ("Нет оборудования"). A plain substring search would miss
    // this; `to_tsvector('russian', ...)` stems both to the same lexeme.
    const hits = await service.search('оборудование', ['engineer'], 20);
    assert.ok(hits.length > 0, 'expected morphological match for "оборудование"');
    assert.ok(
      hits.some((hit) => hit.title.includes('оборудования') || hit.body.includes('оборудования')),
      'expected a hit containing the genitive form "оборудования"',
    );
  });

  it('falls back from websearch_to_tsquery to plainto_tsquery when the first finds nothing', async () => {
    // `websearch_to_tsquery` treats a leading "-" as exclusion, so this becomes
    // "оборудование & !оборудование" -- a query that is well-formed but matches
    // nothing. `plainto_tsquery` has no such syntax: it tokenizes the same text as two
    // plain occurrences of the same word, which does match. A query with zero hits from
    // the first pass and at least one from the second exercises the retry for real,
    // rather than asserting on call counts against a fake.
    const hits = await service.search('оборудование -оборудование', ['engineer'], 20);
    assert.ok(
      hits.length > 0,
      'expected the plainto_tsquery retry to still find the engineer article',
    );
  });

  it('uses the ai_documents_fts index rather than a sequential scan', async () => {
    const query = 'заявка';
    // Isolates the `@@` predicate the GIN index actually covers. The full `search()`
    // query also filters `WHERE segment = ANY(...)`, and on a corpus this small (a few
    // dozen rows) the planner can reasonably prefer the plain `ai_documents_segment_idx`
    // B-tree plus a filter over the GIN bitmap scan for that compound query -- a cost
    // call about a small table, not evidence the FTS index is unusable. Dropping the
    // segment predicate here leaves the text-search condition as the only one an index
    // can serve, so with `enable_seqscan = off` forcing the planner off a sequential
    // scan, `ai_documents_fts` is the only plan left standing -- which is what this
    // assertion needs: proof the index exists, matches the exact indexed expression,
    // and is usable, not a claim about which plan wins under every predicate.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN
        SELECT id
        FROM ai_documents
        WHERE (
          setweight(to_tsvector('russian', title), 'A') ||
          setweight(to_tsvector('russian', summary), 'B') ||
          setweight(to_tsvector('russian', body), 'C')
        ) @@ websearch_to_tsquery('russian', ${query})
      `;
    });
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /ai_documents_fts/);
  });
});
