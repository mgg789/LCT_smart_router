import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { AiOperationService } from '../../src/ai/operations';
import { buildClientTools } from '../../src/ai/tools/client.tools';
import { buildEngineerTools } from '../../src/ai/tools/engineer.tools';
import { buildCallDispatchHelperTool, type HandoffToolDeps } from '../../src/ai/tools/handoff.tool';
import { buildSearchDocumentationTool } from '../../src/ai/tools/knowledge.tool';
import type { KnowledgeSearchPort } from '../../src/ai/tools/knowledge-search.port';
import type { AnyToolSpec } from '../../src/ai/tools/tool.types';
import type { AppConfigService } from '../../src/common/config';
import type { LiveService } from '../../src/orchestrator/live/live.service';
import type { RequestsService } from '../../src/orchestrator/requests/requests.service';

/**
 * Builds the real tool catalogues with inert dependency stand-ins.
 *
 * Every dependency here is a value the tools only *carry a reference to* while being
 * constructed -- `run()` is never called in this file, only `.name`, `.description` and
 * `.schema`, so a stand-in that would throw if actually invoked is deliberately used
 * where a real service would go: this test must fail loudly if it starts exercising
 * business logic; it is a structural check on the catalogue's declarations only.
 */
function realCatalogueUnderTest(): readonly AnyToolSpec[] {
  const inert = new Proxy(
    {},
    {
      get() {
        throw new Error('This test only inspects tool declarations; it must not call a dependency');
      },
    },
  );
  const config = {
    get: (key: string) => (key === 'APP_TIME_ZONE' ? 'Europe/Moscow' : inert),
  } as unknown as AppConfigService;

  const client = buildClientTools({
    aiOperations: inert as unknown as AiOperationService,
    requests: inert as unknown as RequestsService,
    config,
  });
  const engineer = buildEngineerTools({
    aiOperations: inert as unknown as AiOperationService,
    live: inert as unknown as LiveService,
    config,
  });
  const search = buildSearchDocumentationTool(inert as unknown as KnowledgeSearchPort);
  const handoff = buildCallDispatchHelperTool(inert as unknown as HandoffToolDeps);

  return [...client, ...engineer, search, handoff];
}

/** Walks a JSON Schema object depth-first, yielding every property name it declares at
 *  any level (object properties, array items, oneOf/anyOf/allOf branches). */
function* propertyNames(schema: unknown): Generator<string> {
  if (schema === null || typeof schema !== 'object') {
    return;
  }
  const node = schema as Record<string, unknown>;
  const properties = node.properties;
  if (properties !== null && typeof properties === 'object') {
    for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
      yield name;
      yield* propertyNames(value);
    }
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    if (node[key] !== undefined) {
      yield* propertyNames(node[key]);
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        yield* propertyNames(branch);
      }
    }
  }
}

/** The names the subject must always come from `ToolContext` for, never a model
 *  argument -- tool.types.ts's own note on this. */
const FORBIDDEN_ARGUMENT_NAMES = ['engineerId', 'clientEmail', 'accountId', 'segment', 'role'];

describe('AI tool schemas never let the model choose the subject', () => {
  const tools = realCatalogueUnderTest();

  it('finds at least the tools this change adds', () => {
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'call_dispatch_helper',
      'change_status_to',
      'confirm_on_time',
      'create_request',
      'finish_technical_break',
      'get_my_route',
      'list_my_requests',
      'report_cannot_complete',
      'report_delay',
      'report_eta',
      'report_missing_equipment',
      'search_documentation',
      'start_technical_break',
    ]);
  });

  for (const tool of realCatalogueUnderTest()) {
    it(`"${tool.name}" declares no forbidden subject argument`, () => {
      const jsonSchema = z.toJSONSchema(tool.schema);
      const found = [...propertyNames(jsonSchema)].filter((name) =>
        FORBIDDEN_ARGUMENT_NAMES.includes(name),
      );
      assert.deepEqual(
        found,
        [],
        `"${tool.name}" must not declare ${found.join(', ')}; the subject comes from ToolContext`,
      );
    });
  }
});

describe('AI tool schemas never take a raw epoch number', () => {
  const tools = realCatalogueUnderTest();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  /** Every numeric leaf in the schema, by its property name. */
  function numericPropertyNames(schema: unknown): string[] {
    const found: string[] = [];
    const walk = (node: unknown, name?: string) => {
      if (node === null || typeof node !== 'object') {
        return;
      }
      const record = node as Record<string, unknown>;
      if (name !== undefined && (record.type === 'integer' || record.type === 'number')) {
        found.push(name);
      }
      const properties = record.properties;
      if (properties !== null && typeof properties === 'object') {
        for (const [childName, child] of Object.entries(properties as Record<string, unknown>)) {
          walk(child, childName);
        }
      }
    };
    walk(schema);
    return found;
  }

  it('create_request takes a local date and local start/end times, not epoch seconds', () => {
    const tool = byName.get('create_request');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.windowDate?.type, 'string');
    assert.equal(jsonSchema.properties.windowStartLocal?.type, 'string');
    assert.equal(jsonSchema.properties.windowEndLocal?.type, 'string');
    assert.deepEqual(numericPropertyNames(jsonSchema), []);
  });

  it('report_eta takes a local HH:MM, not an epoch number', () => {
    const tool = byName.get('report_eta');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.etaLocal?.type, 'string');
    assert.deepEqual(numericPropertyNames(jsonSchema), []);
  });

  it('report_delay takes whole minutes, an engineer-stated quantity, not a derived duration', () => {
    const tool = byName.get('report_delay');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.minutes?.type, 'integer');
  });
});

describe('AI tool catalogue scoping', () => {
  it('gives the client its own two operations plus the two shared tools', () => {
    const tools = buildClientTools({
      aiOperations: {} as unknown as AiOperationService,
      requests: {} as unknown as RequestsService,
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['create_request', 'list_my_requests']);
  });

  it('gives the engineer exactly the nine liveActionSchema-mapped tools, no start/finish visit', () => {
    const tools = buildEngineerTools({
      aiOperations: {} as unknown as AiOperationService,
      live: {} as unknown as LiveService,
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'change_status_to',
      'confirm_on_time',
      'finish_technical_break',
      'get_my_route',
      'report_cannot_complete',
      'report_delay',
      'report_eta',
      'report_missing_equipment',
      'start_technical_break',
    ]);
    assert.ok(!names.includes('start_visit'));
    assert.ok(!names.includes('finish_visit'));
  });
});
