import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDispatcherSystemPrompt,
  dispatcherTurnReminder,
} from '../../src/ai/profiles/dispatcher.profile';

const input = {
  assistMode: 'help' as const,
  now: 1_790_000_000,
  timeZone: 'Europe/Moscow',
  toolNames: ['get_plan'],
};

describe('dispatcher assistant voice', () => {
  it('uses first person for hypothetical changes', () => {
    const prompt = buildDispatcherSystemPrompt(input);

    assert.match(prompt, /what I would do in Agent mode/);
    assert.match(prompt, /Я бы включил/);
    assert.match(prompt, /режим с изменениями/);
    assert.match(prompt, /this first-person wording is a hypothetical recommendation/);
  });

  it('keeps the first-person rule after conversation history', () => {
    const reminder = dispatcherTurnReminder(input);

    assert.match(reminder, /Consultant/);
    assert.match(reminder, /simple Russian/);
  });
});
