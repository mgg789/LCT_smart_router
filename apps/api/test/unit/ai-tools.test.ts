import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { AiOperationService, PrepareOperationInput } from '../../src/ai/operations';
import { buildClientTools } from '../../src/ai/tools/client.tools';
import type { DispatcherReadToolDeps } from '../../src/ai/tools/dispatcher-read.tools';
import { buildDispatcherReadTools } from '../../src/ai/tools/dispatcher-read.tools';
import type { DispatcherWriteToolDeps } from '../../src/ai/tools/dispatcher-write.tools';
import { buildDispatcherWriteTools } from '../../src/ai/tools/dispatcher-write.tools';
import { buildEngineerTools } from '../../src/ai/tools/engineer.tools';
import { buildSearchDocumentationTool } from '../../src/ai/tools/knowledge.tool';
import type { KnowledgeSearchPort } from '../../src/ai/tools/knowledge-search.port';
import type { AnyToolSpec, ToolContext } from '../../src/ai/tools/tool.types';
import type { Actor } from '../../src/auth';
import type { AppConfigService } from '../../src/common/config';
import { SysError } from '../../src/common/errors';
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
    prisma: inert as never,
    config,
  });
  const engineer = buildEngineerTools({
    aiOperations: inert as unknown as AiOperationService,
    live: inert as unknown as LiveService,
    config,
  });
  const search = buildSearchDocumentationTool(inert as unknown as KnowledgeSearchPort);

  return [...client, ...engineer, search];
}

/**
 * Builds the real dispatcher catalogues (`dispatcher_readonly` + the `dispatcher_fix`
 * preparers on top) the same inert-stand-in way `realCatalogueUnderTest` does above --
 * declarations only, `run()` is never called here.
 */
function dispatcherCatalogueUnderTest(): readonly AnyToolSpec[] {
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

  const read = buildDispatcherReadTools(inert as unknown as DispatcherReadToolDeps);
  const write = buildDispatcherWriteTools({
    aiOperations: inert as unknown as AiOperationService,
    config,
  } satisfies DispatcherWriteToolDeps);
  return [...read, ...write];
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
      'change_status_to',
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
      prisma: {} as never,
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['create_request', 'list_my_requests']);
  });

  it('gives the engineer exactly the eight liveActionSchema-mapped tools, no start/finish visit', () => {
    const tools = buildEngineerTools({
      aiOperations: {} as unknown as AiOperationService,
      live: {} as unknown as LiveService,
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'change_status_to',
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

  it('gives dispatcher_readonly its own thirteen read tools (ToolRegistry adds search_documentation on top)', () => {
    const names = dispatcherCatalogueUnderTest()
      .filter((tool) => !tool.name.startsWith('prepare_'))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(names, [
      'compare_policies',
      'evaluate_manual_order',
      'get_day_plan',
      'get_policies',
      'get_request',
      'get_request_history',
      'get_router_settings',
      'get_shift_status',
      'get_situation',
      'get_snapshot_diagnostics',
      'list_alerts',
      'list_engineers',
      'list_requests',
    ]);
  });

  it('gives dispatcher_fix exactly the twelve documented preparers on top of the read tools', () => {
    const names = dispatcherCatalogueUnderTest()
      .filter((tool) => tool.name.startsWith('prepare_'))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(names, [
      'prepare_cancel_request',
      'prepare_close_shift',
      'prepare_create_request',
      'prepare_engineer_technical_break',
      'prepare_mark_alert_seen',
      'prepare_move_window',
      'prepare_reschedule_request',
      'prepare_resolve_alert',
      'prepare_select_policy',
      'prepare_set_engineer_availability',
      'prepare_set_engineer_workday',
      'prepare_update_request',
    ]);
  });
});

/**
 * `engineerId`/`clientEmail` legitimately appear in the dispatcher catalogue: a dispatcher
 * names *another* person as the object of an action -- reassigning to an engineer,
 * creating a request for a customer by address -- and that object always comes from a
 * model argument, the same way `AlertsService.resolve`'s own `engineerId` (the
 * `add_engineer` target) and `DispatchController.create`'s own `clientEmail` do at the
 * HTTP boundary. What must still never happen is a dispatcher tool taking `accountId`,
 * `segment` or `role` at all (there is no legitimate object reading for those in this
 * catalogue), or `engineerId`/`clientEmail` standing in for the *acting* dispatcher, which
 * this catalogue has no ToolContext field for in the first place -- a dispatcher session's
 * own identity is `ctx.actor`, never `ctx.accountId` treated as "whose data this is" the
 * way a client or engineer session's `ctx.accountId`/`ctx.engineerId` is.
 */
const DISPATCHER_FORBIDDEN_ARGUMENT_NAMES = ['accountId', 'segment', 'role'];

describe('AI dispatcher tool schemas never take accountId, segment or role', () => {
  for (const tool of dispatcherCatalogueUnderTest()) {
    it(`"${tool.name}" declares none of ${DISPATCHER_FORBIDDEN_ARGUMENT_NAMES.join(', ')}`, () => {
      const jsonSchema = z.toJSONSchema(tool.schema);
      const found = [...propertyNames(jsonSchema)].filter((name) =>
        DISPATCHER_FORBIDDEN_ARGUMENT_NAMES.includes(name),
      );
      assert.deepEqual(found, [], `"${tool.name}" must not declare ${found.join(', ')}`);
    });
  }
});

describe('AI dispatcher tool schemas never take a raw epoch number for a time', () => {
  const byName = new Map(dispatcherCatalogueUnderTest().map((tool) => [tool.name, tool]));

  it('prepare_move_window takes a local date and local start/end times', () => {
    const tool = byName.get('prepare_move_window');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.windowDate?.type, 'string');
    assert.equal(jsonSchema.properties.windowStartLocal?.type, 'string');
    assert.equal(jsonSchema.properties.windowEndLocal?.type, 'string');
  });

  it('prepare_set_engineer_workday takes local shift times, not epoch seconds', () => {
    const tool = byName.get('prepare_set_engineer_workday');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.workDate?.type, 'string');
    assert.equal(jsonSchema.properties.shiftStartLocal?.type, 'string');
    assert.equal(jsonSchema.properties.shiftEndLocal?.type, 'string');
  });

  it('prepare_close_shift takes a local date', () => {
    const tool = byName.get('prepare_close_shift');
    assert.ok(tool);
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      properties: Record<string, { type: string }>;
    };
    assert.equal(jsonSchema.properties.workDate?.type, 'string');
  });
});

const engineerActor: Actor = {
  kind: 'account',
  source: 'ui',
  id: 'engineer-1',
  role: 'engineer',
  tokenCategory: null,
  accountId: 'engineer-1',
};

function engineerToolContext(): ToolContext {
  return {
    actor: engineerActor,
    accountId: 'engineer-1',
    engineerId: 'eng-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    segments: ['engineer'],
    now: 1_700_000_000,
  };
}

/** A LIVE service stand-in whose `assertLegacyMutationAllowed` reports the workday as
 *  running or not, matching the real method's own throw-to-mean-"running" contract
 *  (`liveWorkdayRunning` in engineer.tools.ts). */
function liveWithWorkdayRunning(running: boolean): LiveService {
  return {
    assertLegacyMutationAllowed: async () => {
      if (running) throw new SysError('VALIDATION_FAILED', 'LIVE workday is running');
    },
  } as unknown as LiveService;
}

describe('change_status_to(0) during a running LIVE workday', () => {
  it('prepares live.engineer.offline carrying the given reason, not the legacy switch', async () => {
    const calls: PrepareOperationInput[] = [];
    const aiOperations = {
      prepare: async (input: PrepareOperationInput) => {
        calls.push(input);
        return {
          operationId: 'op-1',
          state: 'applied' as const,
          guard: 'clear' as const,
          preview: [],
          expiresAt: 0,
        };
      },
    } as unknown as AiOperationService;
    const tools = buildEngineerTools({
      aiOperations,
      live: liveWithWorkdayRunning(true),
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const changeStatusTo = tools.find((tool) => tool.name === 'change_status_to');
    assert.ok(changeStatusTo);

    const result = await changeStatusTo.run(engineerToolContext(), {
      status: 0,
      note: 'Плохое самочувствие, продолжить не смогу',
    });

    assert.ok(result.ok);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'live.engineer.offline');
    assert.equal(calls[0]?.targetRef, 'eng-1');
    assert.deepEqual(calls[0]?.payload, { note: 'Плохое самочувствие, продолжить не смогу' });
  });

  it('refuses to prepare anything without a reason', async () => {
    const aiOperations = {
      prepare: async () => {
        throw new Error('must not be called without a reason');
      },
    } as unknown as AiOperationService;
    const tools = buildEngineerTools({
      aiOperations,
      live: liveWithWorkdayRunning(true),
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const changeStatusTo = tools.find((tool) => tool.name === 'change_status_to');
    assert.ok(changeStatusTo);

    await assert.rejects(
      () => changeStatusTo.run(engineerToolContext(), { status: 0 }),
      (error: unknown) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
    );
  });

  it('status: 1 still prepares live.engineer.online, unaffected by the offline change', async () => {
    const calls: PrepareOperationInput[] = [];
    const aiOperations = {
      prepare: async (input: PrepareOperationInput) => {
        calls.push(input);
        return {
          operationId: 'op-2',
          state: 'applied' as const,
          guard: 'clear' as const,
          preview: [],
          expiresAt: 0,
        };
      },
    } as unknown as AiOperationService;
    const tools = buildEngineerTools({
      aiOperations,
      live: liveWithWorkdayRunning(true),
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const changeStatusTo = tools.find((tool) => tool.name === 'change_status_to');
    assert.ok(changeStatusTo);

    const result = await changeStatusTo.run(engineerToolContext(), { status: 1 });

    assert.ok(result.ok);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'live.engineer.online');
  });
});
