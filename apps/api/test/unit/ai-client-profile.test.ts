import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildClientSystemPrompt } from '../../src/ai/profiles/client.profile';
import { formatUnixSeconds } from '../../src/common/time';
import { WORK_TYPE_CODES } from '../../src/orchestrator/requests/work-type.catalog';

const TIME_ZONE = 'Europe/Moscow';
const NOW = 1_790_000_000; // 2026-09-16T15:33:20Z -- an arbitrary, fixed business moment.

describe('buildClientSystemPrompt', () => {
  it("states today's date in the configured zone", () => {
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.ok(
      prompt.includes(formatUnixSeconds(NOW, TIME_ZONE)),
      'expected the formatted business-clock date to appear verbatim',
    );
    assert.match(prompt, /tomorrow/i);
  });

  it('instructs the assistant to answer in Russian', () => {
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /\bRussian\b/);
  });

  it('lists every tool actually offered this turn, and only those', () => {
    const toolNames = ['create_request', 'list_my_requests', 'search_documentation'];
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames });
    for (const name of toolNames) {
      assert.ok(prompt.includes(name), `expected the prompt to name tool "${name}"`);
    }
    assert.ok(!prompt.includes('call_dispatch_helper'), 'a tool not offered must not be named');
  });

  it('explains human handoff when the dispatcher tool is available', () => {
    const prompt = buildClientSystemPrompt({
      now: NOW,
      timeZone: TIME_ZONE,
      toolNames: ['call_dispatch_helper'],
    });
    assert.match(prompt, /call_dispatch_helper/);
    assert.match(prompt, /same turn/);
  });

  it('lists all 16 work-type codes from the real catalogue', () => {
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.equal(WORK_TYPE_CODES.length, 16);
    for (const code of WORK_TYPE_CODES) {
      assert.ok(prompt.includes(code), `expected work-type code "${code}" in the prompt`);
    }
  });

  it('states that derived fields are never asked of the customer or guessed', () => {
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /never (ask|invent|guess)/i);
  });

  it('states a mutating tool only ever prepares a card a human confirms', () => {
    const prompt = buildClientSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /confirm/i);
    assert.match(prompt, /never (say|state)[^.]*(filed|scheduled|working)/i);
  });
});
