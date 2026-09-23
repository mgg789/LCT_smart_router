import { API_BASE, API_PREFIX } from '../config/env';
import { ApiError, codeForEnvelopeless, NETWORK_ERROR_CODE, parseErrorEnvelope } from './errors';

/**
 * Splits a Server-Sent Events byte stream into the JSON payloads it carries.
 *
 * Deliberately `fetch` + `ReadableStream` rather than `EventSource`
 * (docs/frontend-api.md §9.1): `EventSource` cannot send an `Authorization`
 * header, and this project forbids putting the bearer token in the URL, where it
 * would settle in browser history, proxy logs and the `Referer` of every later
 * request. There is no third transport that satisfies both, so this is not a
 * style choice to "simplify" back to `EventSource`.
 */

/** Frames are separated by a blank line; either newline style is legal. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

/**
 * Pulls the payload out of one frame, or returns null when it carries none.
 *
 * A frame may spread its payload over several `data:` lines, which concatenate
 * into a single JSON document. A frame without any — a `: ping` heartbeat, or a
 * bare `event:` line — is not an empty message but a non-message, and must never
 * reach the parser.
 */
export function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * Accumulates chunks and yields the frames that have completed.
 *
 * The tail is kept rather than parsed: a frame cut across a chunk boundary is
 * incomplete, not malformed, and guessing at its remainder would invent an event
 * the server never sent.
 */
export class FrameBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const frames = this.pending.split(FRAME_BOUNDARY);
    // The last piece has no terminator yet, so it stays for the next chunk.
    this.pending = frames.pop() ?? '';
    return frames;
  }

  /** What a closed stream left behind — a final frame the server did not terminate. */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = '';
    return rest ? [rest] : [];
  }
}

export interface EventStreamOptions {
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Opens an SSE route under `/api/v1` and yields each frame's parsed payload.
 *
 * Failures before the stream opens arrive as {@link ApiError}, the same type the
 * rest of the API layer throws. After the headers are sent the server renders a
 * terminal failure as an ordinary event instead (§9.3 `error`), so a consumer
 * that has started reading never has to catch to learn the outcome.
 */
export async function* readEventStream<T>(
  path: string,
  options: EventStreamOptions = {},
): AsyncGenerator<T> {
  const { token, signal } = options;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${API_PREFIX}${path}`, { headers, signal });
  } catch (cause) {
    throw new ApiError(0, {
      code: NETWORK_ERROR_CODE,
      message: cause instanceof Error ? cause.message : 'Stream failed before reaching the API',
    });
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = parseErrorEnvelope(payload);
    throw new ApiError(
      response.status,
      envelope ?? {
        code: codeForEnvelopeless(response.status),
        message: response.statusText || `HTTP ${response.status}`,
      },
    );
  }
  if (!response.body) {
    throw new ApiError(response.status, {
      code: NETWORK_ERROR_CODE,
      message: 'The stream answered without a readable body',
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffer = new FrameBuffer();

  try {
    while (true) {
      const { done, value } = await reader.read();
      const chunks = done
        ? [...buffer.push(decoder.decode()), ...buffer.flush()]
        : buffer.push(decoder.decode(value, { stream: true }));
      for (const frame of chunks) {
        const data = frameData(frame);
        if (data === null) continue;
        yield JSON.parse(data) as T;
      }
      if (done) return;
    }
  } finally {
    // Leaving the loop early — the consumer stopped, or the component unmounted —
    // must also let go of the socket, or the response stays open for the tab's life.
    await reader.cancel().catch(() => undefined);
  }
}
