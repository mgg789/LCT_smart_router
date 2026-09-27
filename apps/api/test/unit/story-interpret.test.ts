import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MiniAiService } from '../../src/orchestrator/ai/mini-ai.service';

test('story extraction uses one LLM call and retains a canonical emergency type', async (t) => {
  const previous = process.env.LLM_TOKEN;
  process.env.LLM_TOKEN = 'unit-test-only';
  t.after(() => {
    if (previous === undefined) delete process.env.LLM_TOKEN;
    else process.env.LLM_TOKEN = previous;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.ok(url.endsWith('/chat/completions'));
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              workType: 'outage',
              problem: 'Авария',
              contactName: 'Виктор Михайленко',
              address: 'проспект вернадского 11',
              windowStart: '11:00',
              windowEnd: '13:00',
              email: '',
            }),
          },
        },
      ],
    });
  });
  const result = await new MiniAiService().interpretStory(
    'У меня авария интернет вообще не работает проспект вернадского 11, я виктор михайленко, надо срочно',
  );
  assert.equal(calls, 1);
  assert.equal(result.workType, 'outage');
  assert.equal(result.contactName, 'Виктор Михайленко');
  assert.equal(result.address, 'проспект вернадского 11');
  assert.equal(result.windowStart, '');
});
