// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAiExplain, streamAssistantRun } from '../api/ai';
import { useAiExplanation } from './useAiExplanation';

vi.mock('../api/ai', () => ({
  requestAiExplain: vi.fn(),
  streamAssistantRun: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe('dashboard AI explanation', () => {
  it('requests the current plan scope and reads the final streamed answer', async () => {
    vi.mocked(requestAiExplain).mockResolvedValue({ runId: 'run-1' });
    vi.mocked(streamAssistantRun).mockImplementation(async (_id, _token, _seq, onEvent) => {
      onEvent({
        ok: true,
        event: {
          type: 'message',
          seq: 1,
          at: 100,
          messageId: 'm-1',
          messageSeq: 1,
          kind: 'text',
          text: 'План требует внимания.',
          actions: [],
        },
      });
      onEvent({
        ok: true,
        event: {
          type: 'run_finished',
          seq: 2,
          at: 101,
          state: 'completed',
          usage: { promptTokens: 1, completionTokens: 1, costMicros: 0 },
        },
      });
    });

    const { result } = renderHook(() =>
      useAiExplanation({ enabled: true, token: 'token', target: { scope: 'plan' } }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.text).toBe('План требует внимания.');
    expect(requestAiExplain).toHaveBeenCalledWith('token', { scope: 'plan' });
    expect(streamAssistantRun).toHaveBeenCalledWith(
      'run-1',
      'token',
      0,
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('passes the selected request id to the existing explainer', async () => {
    vi.mocked(requestAiExplain).mockResolvedValue({ runId: 'run-2' });
    vi.mocked(streamAssistantRun).mockResolvedValue();
    renderHook(() =>
      useAiExplanation({
        enabled: true,
        token: 'token',
        target: { scope: 'request', requestId: 'request-42' },
      }),
    );
    await waitFor(() =>
      expect(requestAiExplain).toHaveBeenCalledWith('token', {
        scope: 'request',
        requestId: 'request-42',
      }),
    );
  });
});
