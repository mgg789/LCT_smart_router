import { describe, expect, it } from 'vitest';
import type { AiMessage } from '../api/ai';
import { resumedHandoffStatus } from './useAssistantChat';

function message(seq: number, author: AiMessage['author'], text = 'x'): AiMessage {
  return {
    id: `m-${seq}`,
    conversationId: 'c-1',
    seq,
    author,
    kind: 'text',
    text,
    actions: [],
    runId: null,
    operationId: null,
    authorAccountId: null,
    createdAt: 1_000 + seq,
  };
}

describe('resumedHandoffStatus', () => {
  it('says nothing about a handover while the assistant still owns the dialogue', () => {
    expect(resumedHandoffStatus('assistant', [message(1, 'user'), message(2, 'assistant')])).toBe(
      null,
    );
  });

  /** The reason this exists: the mode flips when the handover is queued, so mode alone
   *  used to promise «На связи диспетчер» before anyone had seen the chat. */
  it('waits while the handover is queued and no dispatcher has written yet', () => {
    expect(resumedHandoffStatus('dispatcher', [message(1, 'user'), message(2, 'system')])).toBe(
      'waiting',
    );
  });

  it('reads a dispatcher on the line once their reply is the newest word', () => {
    expect(resumedHandoffStatus('dispatcher', [message(1, 'user'), message(2, 'dispatcher')])).toBe(
      'answered',
    );
  });

  /** Mirrors `markAwaitingDispatcher`: writing again puts the person back in the queue. */
  it('goes back to waiting when the person wrote after the last dispatcher reply', () => {
    expect(
      resumedHandoffStatus('dispatcher', [
        message(1, 'user'),
        message(2, 'dispatcher'),
        message(3, 'user'),
      ]),
    ).toBe('waiting');
  });

  it('treats a chat the dispatcher opened, with no reply yet from either side, as waiting', () => {
    expect(resumedHandoffStatus('dispatcher', [])).toBe('waiting');
  });
});
