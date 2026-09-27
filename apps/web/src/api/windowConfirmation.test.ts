import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestJson } from './client';
import {
  answerWindowConfirmation,
  confirmWindowChange,
  currentWindowConfirmation,
  subscribeWindowConfirmation,
  WindowChangeDeclined,
} from './windowConfirmation';

const change = {
  kind: 'window_change_confirmation' as const,
  requestId: 'r1',
  version: 1,
  previousStartAt: 100,
  previousEndAt: 200,
  windowStartAt: 300,
  windowEndAt: 400,
  confirmation: 'test-approval',
};
afterEach(() => {
  vi.unstubAllGlobals();
});

it('does not repeat the write until a person confirms, preserving idempotency and bounds', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { details: change } }), { status: 400 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetch);
  const stop = subscribeWindowConfirmation(() => {});
  const init = {
    method: 'POST',
    body: JSON.stringify({ operationId: 'same-id', windowStartAt: 300 }),
  };
  const pending = requestJson('/resolve', z.object({ ok: z.boolean() }), 'session', init);
  await vi.waitFor(() => expect(currentWindowConfirmation()).toEqual(change));
  expect(fetch).toHaveBeenCalledTimes(1);
  answerWindowConfirmation(true);
  await expect(pending).resolves.toEqual({ ok: true });
  expect(fetch.mock.calls[1]?.[1].body).toBe(init.body);
  expect(fetch.mock.calls[1]?.[1].headers['x-window-change-confirmation']).toBe('test-approval');
  stop();
});

it('declining skips the write instead of closing the alert', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: { details: change } }), { status: 400 }),
    );
  vi.stubGlobal('fetch', fetch);
  const stop = subscribeWindowConfirmation(() => {});
  const pending = requestJson('/resolve', z.unknown(), 'session', { method: 'POST' });
  const rejection = expect(pending).rejects.toBeInstanceOf(WindowChangeDeclined);
  await vi.waitFor(() => expect(currentWindowConfirmation()).toEqual(change));
  answerWindowConfirmation(false);
  await rejection;
  expect(fetch).toHaveBeenCalledTimes(1);
  stop();
});

it('queues separate changes and fails closed when the dialog unmounts', async () => {
  const stop = subscribeWindowConfirmation(() => {});
  const first = confirmWindowChange(change);
  const second = confirmWindowChange({ ...change, requestId: 'r2' });
  answerWindowConfirmation(true);
  await expect(first).resolves.toBe(true);
  expect(currentWindowConfirmation()?.requestId).toBe('r2');
  stop();
  await expect(second).resolves.toBe(false);
  await expect(confirmWindowChange(change)).resolves.toBe(false);
});

it('stops after one approval when the server reports a changed request', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ error: { details: change } }), { status: 422 }),
    );
  vi.stubGlobal('fetch', fetch);
  const stop = subscribeWindowConfirmation(() => {});
  const pending = requestJson('/resolve', z.unknown(), 'session', { method: 'POST' });
  const rejection = expect(pending).rejects.toMatchObject({ status: 409 });
  await vi.waitFor(() => expect(currentWindowConfirmation()).toEqual(change));
  answerWindowConfirmation(true);
  await rejection;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(currentWindowConfirmation()).toBeNull();
  stop();
});
