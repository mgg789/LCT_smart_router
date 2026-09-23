import { describe, expect, it } from 'vitest';
import type { AiRunEvent } from '@/entities/conversation';
import { blankAnswer, foldRunEvent } from './foldRunEvent';

const STARTED_AT = 1_700_000_000;

function fold(...events: AiRunEvent[]) {
  return events.reduce(
    (message, event) => foldRunEvent(message, event, STARTED_AT),
    blankAnswer('a1', 'u1'),
  );
}

function delta(text: string, seq: number): AiRunEvent {
  return { type: 'message_delta', seq, at: STARTED_AT, messageId: 'm1', text };
}

describe('foldRunEvent', () => {
  it('grows the answer as deltas arrive', () => {
    expect(fold(delta('Заявка ', 1), delta('без назначения', 2)).text).toBe(
      'Заявка без назначения',
    );
  });

  it('replaces the streamed draft with the finished message, which alone carries buttons', () => {
    const message = fold(delta('частич', 1), {
      type: 'message',
      seq: 2,
      at: STARTED_AT,
      messageId: 'm1',
      messageSeq: 4,
      kind: 'text_action',
      text: 'Готовый ответ',
      actions: [{ kind: 'confirm_operation', label: 'Подтвердить', operationId: 'op-1' }],
    });

    expect(message.text).toBe('Готовый ответ');
    expect(message.actions).toHaveLength(1);
  });

  it('keeps the tool journal in the order the run wrote it', () => {
    const message = fold(
      {
        type: 'tool_started',
        seq: 1,
        at: STARTED_AT,
        toolName: 'get_day_plan',
        intent: 'Смотрю план',
      },
      {
        type: 'tool_result',
        seq: 2,
        at: STARTED_AT,
        toolName: 'get_day_plan',
        ok: true,
        summary: 'План прочитан',
      },
    );

    expect(message.notes).toEqual(['Смотрю план', 'План прочитан']);
  });

  it('marks a failed tool as failed rather than dropping it', () => {
    const message = fold({
      type: 'tool_result',
      seq: 1,
      at: STARTED_AT,
      toolName: 'compare_policies',
      ok: false,
      summary: 'Router не ответил',
    });

    expect(message.notes).toEqual(['Не удалось: Router не ответил']);
  });

  it('carries a prepared card and then its new state, keeping the preview', () => {
    const message = fold(
      {
        type: 'operation_prepared',
        seq: 1,
        at: STARTED_AT,
        operationId: 'op-1',
        action: 'request.move_window',
        targetRef: 'req-1',
        state: 'awaiting_confirmation',
        preview: [{ label: 'Окно', value: '14:00–15:00' }],
        expiresAt: STARTED_AT + 300,
      },
      { type: 'operation_state', seq: 2, at: STARTED_AT, operationId: 'op-1', state: 'applied' },
    );

    expect(message.cards).toEqual([
      {
        operationId: 'op-1',
        action: 'request.move_window',
        state: 'applied',
        preview: [{ label: 'Окно', value: '14:00–15:00' }],
        error: null,
      },
    ]);
  });

  it('keeps a refusal reason from the state that carried it', () => {
    const message = fold(
      {
        type: 'operation_prepared',
        seq: 1,
        at: STARTED_AT,
        operationId: 'op-1',
        action: 'request.cancel',
        targetRef: null,
        state: 'prepared',
        preview: [],
        expiresAt: STARTED_AT + 300,
      },
      {
        type: 'operation_state',
        seq: 2,
        at: STARTED_AT,
        operationId: 'op-1',
        state: 'rejected',
        error: { code: 'REQUEST_NOT_SUBMITTED', message: 'Заявка уже закрыта' },
      },
    );

    expect(message.cards[0]?.state).toBe('rejected');
    expect(message.cards[0]?.error).toBe('Заявка уже закрыта');
  });

  it('renders a terminal error as the failure it is, with its code', () => {
    const message = fold({
      type: 'error',
      seq: 1,
      at: STARTED_AT,
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: 'Модель недоступна',
    });

    expect(message.failure).toBe('Модель недоступна (AI_PROVIDER_UNAVAILABLE)');
  });

  it('names a handover as such rather than as a failed answer', () => {
    expect(fold({ type: 'stopped', seq: 1, at: STARTED_AT, reason: 'handover' }).failure).toBe(
      'Диалог передан диспетчеру — ассистент замолчал.',
    );
  });

  it('measures the thinking time from the run’s own clock and ends the stream', () => {
    const message = fold({
      type: 'run_finished',
      seq: 1,
      at: STARTED_AT + 7,
      state: 'completed',
      usage: { promptTokens: 10, completionTokens: 20, costMicros: 30 },
    });

    expect(message.streaming).toBe(false);
    expect(message.thoughtSec).toBe(7);
  });

  it('never reports a negative duration when the server clock runs behind', () => {
    const message = fold({
      type: 'run_finished',
      seq: 1,
      at: STARTED_AT - 3,
      state: 'completed',
      usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 },
    });

    expect(message.thoughtSec).toBe(0);
  });

  it('leaves the answer alone for events that belong to the dialogue, not to it', () => {
    const before = blankAnswer('a1', 'u1');
    const after = foldRunEvent(
      before,
      {
        type: 'quota',
        seq: 1,
        at: STARTED_AT,
        remainingMicros: 5,
        remainingMessages: 3,
        resetAt: 0,
      },
      STARTED_AT,
    );

    expect(after).toBe(before);
  });
});
