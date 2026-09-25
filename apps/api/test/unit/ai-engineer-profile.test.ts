import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEngineerSystemPrompt } from '../../src/ai/profiles/engineer.profile';
import { formatUnixSeconds } from '../../src/common/time';

const TIME_ZONE = 'Europe/Moscow';
const NOW = 1_790_000_000; // 2026-09-16T15:33:20Z -- an arbitrary, fixed business moment.

describe('buildEngineerSystemPrompt', () => {
  it("states today's date in the configured zone and the LIVE business clock", () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.ok(
      prompt.includes(formatUnixSeconds(NOW, TIME_ZONE)),
      'expected the formatted business-clock date to appear verbatim',
    );
    assert.match(prompt, /tomorrow/i);
    assert.match(prompt, /liveNow/);
  });

  it('instructs the assistant to answer in Russian', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /\bRussian\b/);
  });

  it("states the tool names actually offered this turn, read from the caller's own list", () => {
    const toolNames = ['report_delay', 'report_eta', 'get_my_route'];
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames });
    for (const name of toolNames) {
      assert.ok(prompt.includes(name), `expected the prompt to name tool "${name}"`);
    }
    // A tool from a different profile's catalogue entirely (dispatcher-only) must never
    // appear: the situation table below is static domain knowledge about this profile's
    // *own* catalogue (`engineer.tools.ts`), never a stand-in for the dynamic per-turn
    // list this assertion actually checks.
    assert.ok(!prompt.includes('dispatcher_set_control_mode'), 'a foreign tool must not appear');
  });

  it("says a delay keeps the visit and needs the engineer's own minutes estimate", () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /report_delay/);
    assert.match(prompt, /in progress/i);
    assert.match(prompt, /minutes/i);
  });

  it('says missing equipment, cannot-complete and other all cancel the visit', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /report_missing_equipment[\s\S]*[Cc]ancels the visit/);
    assert.match(prompt, /"impossible"[\s\S]*[Cc]ancels the visit/);
    assert.match(prompt, /"other"[\s\S]*[Cc]ancels the visit/);
  });

  it('never lets the assistant record arrival or completion itself', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /never record|do not (record|describe a visit as started)/i);
  });

  it('does not offer a handoff to the dispatcher', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.equal(prompt.includes('call_dispatch_helper'), false);
    assert.match(prompt, /handing the chat over is not available/i);
  });

  it('allows a technical break while the next visit is only waiting', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /only waiting/);
    assert.match(prompt, /already in progress/);
  });

  it('says a write tool performs the change and only claims it after the tool result', () => {
    const prompt = buildEngineerSystemPrompt({ now: NOW, timeZone: TIME_ZONE, toolNames: [] });
    assert.match(prompt, /performs the change/i);
    assert.match(prompt, /before that tool result/i);
  });
});
