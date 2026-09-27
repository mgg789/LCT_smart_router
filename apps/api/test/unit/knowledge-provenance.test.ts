import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeService } from '../../src/ai/knowledge/knowledge.service';
import { buildSearchDocumentationTool } from '../../src/ai/tools/knowledge.tool';
import type { KnowledgeSearchPort } from '../../src/ai/tools/knowledge-search.port';
import type { ToolContext } from '../../src/ai/tools/tool.types';
import type { PrismaService } from '../../src/persistence';

const row = {
  id: 'doc',
  slug: 'eng-troubleshooting',
  section: 'Проверка',
  title: 'Диагностика',
  summary: 'Границы диагностики',
  body: 'Уточните модель устройства.',
  segment: 'engineer' as const,
  actions: [],
  sourcePath: 'docs/knowledge/engineer/18-device-troubleshooting-boundaries.md',
  updatedAt: 1790370000n,
  checksum: 'content-v1',
};

const context: ToolContext = {
  actor: {
    kind: 'account',
    source: 'ui',
    id: 'account',
    role: 'engineer',
    accountId: 'account',
    tokenCategory: null,
  },
  accountId: 'account',
  engineerId: 'engineer',
  conversationId: 'chat',
  runId: 'run',
  segments: ['engineer'],
  now: 1790370000,
};

describe('knowledge provenance', () => {
  it('carries document date and exact source version through the real service and tool', async () => {
    const service = new KnowledgeService({
      $queryRaw: async () => [row],
    } as unknown as PrismaService);
    const tool = buildSearchDocumentationTool(service);
    const result = await tool.run(context, { query: 'роутер' });
    const payload = JSON.parse(result.resultContent);
    assert.deepEqual(payload.results[0].source, {
      path: row.sourcePath,
      updatedAt: Number(row.updatedAt),
      version: row.checksum,
    });
    assert.equal(payload.results[0].section, 'Проверка');
  });

  it('keeps the knowledge scope tied to the actor instead of the model query', async () => {
    let searched: unknown;
    const port = {
      search: async (_query: string, segments: unknown) => {
        searched = segments;
        return [];
      },
    } as KnowledgeSearchPort;
    const tool = buildSearchDocumentationTool(port);
    const result = await tool.run(context, {
      query: 'dispatcher admin',
    });
    assert.deepEqual(searched, ['engineer']);
    assert.deepEqual(JSON.parse(result.resultContent).results, []);
  });
});
