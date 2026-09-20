import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AiStreamOutcome, streamAssistantRun } from './ai';

afterEach(() => vi.unstubAllGlobals());

/** Builds a fetch stub whose response streams the given raw text chunks one at a time. */
function stubStreamingFetch(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
  const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

/** A stream that never enqueues or closes on its own; it only errors when told to abort. */
function stubAbortableFetch() {
  let onAbort: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => controller.error(new DOMException('Aborted', 'AbortError'));
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  );
  return { triggerAbort: () => onAbort?.() };
}

/** Returns the sole element of a length-1 array without a non-null assertion. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined || items.length !== 1) throw new Error('expected exactly one item');
  return item;
}

async function collect(
  runId: string,
  chunks: readonly string[],
  signal?: AbortSignal,
): Promise<AiStreamOutcome[]> {
  stubStreamingFetch(chunks);
  const outcomes: AiStreamOutcome[] = [];
  await streamAssistantRun(runId, 'token', 0, (outcome) => outcomes.push(outcome), signal);
  return outcomes;
}

describe('streamAssistantRun frame parsing', () => {
  it('reassembles one frame split across chunk boundaries', async () => {
    const event = { type: 'message_delta', seq: 1, at: 100, messageId: 'm1', text: 'Привет' };
    const wholeFrame = `data: ${JSON.stringify(event)}\n\n`;
    // Split mid-way through the JSON payload, well inside the data: line.
    const cut = wholeFrame.indexOf('"messageId"');
    const outcomes = await collect('run1', [wholeFrame.slice(0, cut), wholeFrame.slice(cut)]);
    expect(only(outcomes)).toEqual({ ok: true, event });
  });

  it('ignores a heartbeat comment line and keeps reading real events after it', async () => {
    const event = { type: 'stopped', seq: 2, at: 200, reason: 'user' };
    const outcomes = await collect('run1', [': ping\n\n', `data: ${JSON.stringify(event)}\n\n`]);
    expect(only(outcomes)).toEqual({ ok: true, event });
  });

  it('reports a malformed event instead of dropping it silently', async () => {
    const outcomes = await collect('run1', ['data: {not json\n\n']);
    const outcome = only(outcomes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain('повреждено');
    }
  });

  it('reports an event that is valid JSON but fails the contract schema', async () => {
    const outcomes = await collect('run1', [
      `data: ${JSON.stringify({ type: 'message_delta', seq: 1, at: 1 })}\n\n`,
    ]);
    const outcome = only(outcomes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain('не соответствует контракту');
    }
  });

  it('stops the reader on abort instead of throwing', async () => {
    const { triggerAbort } = stubAbortableFetch();
    const controller = new AbortController();
    const outcomes: AiStreamOutcome[] = [];
    const run = streamAssistantRun(
      'run1',
      'token',
      0,
      (outcome) => outcomes.push(outcome),
      controller.signal,
    );
    controller.abort();
    triggerAbort();
    await expect(run).resolves.toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });
});
