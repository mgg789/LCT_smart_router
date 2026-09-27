import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionGuardService } from '../../src/ai/operations/action-guard';
import { LiveSettingsProvider } from '../../src/ai/provider/live-settings.provider';
import {
  EMPTY_PROVIDER_OUTCOME,
  type LlmStreamEvent,
  type LlmTurnInput,
} from '../../src/ai/provider/llm.types';
import { LlmProvider } from '../../src/ai/provider/llm-provider.port';
import { AppConfigService } from '../../src/common/config';
import type { Env } from '../../src/common/config/env.schema';
import { AiService } from '../../src/orchestrator/ai/ai.service';
import {
  AiConnectionsService,
  resolveAiConnections,
  type StoredAiConnections,
} from '../../src/orchestrator/ai/ai-connections.service';
import { MiniAiService } from '../../src/orchestrator/ai/mini-ai.service';
import type { WeatherDayCacheService } from '../../src/orchestrator/ai/weather-day-cache.service';
import { APP_STATE_KEYS, type PrismaService, type Tx } from '../../src/persistence';
import type { RouterClient } from '../../src/routing/router-gateway';

const values = {
  LLM_BASE_URL: 'https://initial.example/v1',
  LLM_MODEL: 'initial-model',
  LLM_TOKEN: 'fixture-initial-token',
  JEV_API_URL: 'https://sys1.example',
  JEV_MODEL: 'guard-model',
  JEV_API_KEY: 'fixture-guard-token',
};
const config = {
  get: <K extends keyof Env>(key: K) => values[key as keyof typeof values],
  isProduction: false,
} as AppConfigService;
function fixture() {
  let value: StoredAiConnections | null = null;
  const db = {
    appState: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === APP_STATE_KEYS.AI_SETTINGS && value ? { value } : null,
      upsert: async ({ update }: { update: { value: StoredAiConnections } }) => {
        value = update.value;
      },
    },
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  };
  const connections = new AiConnectionsService(db as unknown as PrismaService, config);
  const ai = new AiService(
    db as unknown as PrismaService,
    {} as RouterClient,
    config,
    {} as WeatherDayCacheService,
    connections,
  );
  return { ai, connections, tx: db as unknown as Tx };
}

test('settings expose effective env values masked, preserve blank keys and honor explicit clearing', async () => {
  const { ai, tx } = fixture();
  const initial = await ai.present(null);
  assert.equal(initial.settings.llmApiUrl, values.LLM_BASE_URL);
  assert.equal(initial.settings.llmModel, values.LLM_MODEL);
  assert.equal(initial.settings.llmApiKeySet, true);
  assert.equal(JSON.stringify(initial).includes(values.LLM_TOKEN), false);
  let stored = await ai.replace(tx, 1, {
    llmApiKey: 'fixture-new-secret',
    jevApiKey: 'fixture-new-guard',
  });
  stored = await ai.replace(tx, 2, { llmApiKey: '', jevApiKey: ' ' });
  assert.equal(resolveAiConnections(stored, config).llm.key, 'fixture-new-secret');
  const view = await ai.present(stored);
  assert.equal(view.settings.llmApiKeyLast4, 'cret');
  assert.equal(JSON.stringify(view).includes('fixture-new-secret'), false);
  stored = await ai.replace(tx, 3, { clearLlmApiKey: true });
  assert.equal(resolveAiConnections(stored, config).llm.key, null);
  assert.equal((await ai.present(stored)).settings.llmApiKeySet, false);
});

test('saved connections immediately change MiniAI and System one requests', async (t) => {
  const { ai, connections, tx } = fixture();
  await ai.replace(tx, 1, {
    llmApiUrl: 'https://new.example/v1',
    llmModel: 'new-model',
    llmApiKey: 'fixture-new-secret',
    jevApiUrl: 'https://new-guard.example',
    jevModel: 'new-guard-model',
    jevApiKey: 'fixture-new-guard',
  });
  const seen: Array<{ url: string; model: string; auth: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    seen.push({ url, model: body.model, auth: new Headers(init?.headers).get('authorization') });
    return Response.json(
      url.endsWith('/noul')
        ? { noul: 0.9 }
        : { choices: [{ message: { content: 'Краткое объяснение.' } }] },
    );
  });
  await new MiniAiService(connections).explain('reasons', { requestId: 'test' });
  assert.equal(
    await new ActionGuardService(undefined, undefined, connections).review(
      'test',
      'context',
      'delta',
    ),
    'allowed',
  );
  assert.deepEqual(
    seen.map(({ url, model }) => ({ url, model })),
    [
      { url: 'https://new.example/v1/chat/completions', model: 'new-model' },
      { url: 'https://new-guard.example/v1/noul', model: 'new-guard-model' },
    ],
  );
  assert.ok(seen[0]?.auth === 'Bearer fixture-new-secret');
  assert.ok(seen[1]?.auth === 'Bearer fixture-new-guard');
});

test('live provider refreshes its client and overrides stale run model after a settings save', async () => {
  const { ai, connections, tx } = fixture();
  const models: string[] = [];
  const urls: string[] = [];
  class Capture extends LlmProvider {
    readonly kind = 'openai_chat' as const;
    isConfigured() {
      return true;
    }
    lastOutcome() {
      return EMPTY_PROVIDER_OUTCOME;
    }
    async *turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
      models.push(input.model);
      yield { type: 'done', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
    }
  }
  const provider = new LiveSettingsProvider('openai_chat', connections, (connection) => {
    urls.push(connection.url);
    return new Capture();
  });
  const input: LlmTurnInput = {
    model: 'stale',
    system: '',
    messages: [],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  };
  for await (const _event of provider.turn(input)) {
    /* Drain the response. */
  }
  await ai.replace(tx, 1, { llmApiUrl: 'https://changed.example/v1', llmModel: 'changed-model' });
  for await (const _event of provider.turn(input)) {
    /* Drain the response. */
  }
  assert.deepEqual(models, ['initial-model', 'changed-model']);
  assert.equal(urls.at(-1), 'https://changed.example/v1');
});
