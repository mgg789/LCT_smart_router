import type { BrowserOptions, ErrorEvent, StackFrame } from '@sentry/browser';

export interface FrontendSentryConfig {
  readonly VITE_SENTRY_ENABLED?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}
export type FrontendErrorCode =
  | 'UI_RENDER_FAILURE'
  | 'UI_UNHANDLED_ERROR'
  | 'UI_UNHANDLED_REJECTION';
interface SentryPort {
  init(options: BrowserOptions): unknown;
  captureEvent(event: ErrorEvent): unknown;
}
const codes: readonly FrontendErrorCode[] = [
  'UI_RENDER_FAILURE',
  'UI_UNHANDLED_ERROR',
  'UI_UNHANDLED_REJECTION',
];

function validDsn(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      Boolean(url.username) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[\w/-]*\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function deploymentLabel(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : undefined;
}

/** Keep only build asset basenames and numeric source positions, never full URLs or source text. */
function safeFrame(
  filename: string | undefined,
  lineno?: number,
  colno?: number,
): StackFrame | null {
  const basename = filename?.split(/[?#]/, 1)[0]?.split('/').pop();
  if (!basename || !/^[a-zA-Z0-9_.-]{1,120}\.(?:m?js|tsx?)$/.test(basename)) return null;
  if (!Number.isSafeInteger(lineno) || (lineno ?? 0) < 1) return null;
  return {
    filename: basename,
    lineno,
    ...(Number.isSafeInteger(colno) && (colno ?? 0) > 0 ? { colno } : {}),
  };
}

/** Parse source positions locally; the exception and its message never reach the SDK. */
function sourceFrames(error: unknown): StackFrame[] {
  try {
    if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
    return error.stack
      .split('\n')
      .slice(1, 21)
      .flatMap((line) => {
        const match = line.match(/(?:https?:\/\/|\/)[^\s()]+:(\d+):(\d+)\)?$/);
        if (!match) return [];
        const location = match[0].replace(/:(\d+):(\d+)\)?$/, '');
        const frame = safeFrame(location, Number(match[1]), Number(match[2]));
        return frame ? [frame] : [];
      })
      .reverse();
  } catch {
    return [];
  }
}

/** Rebuild an allowlisted event: retain only fixed codes and sanitized source locations, never messages, URLs or identities. */
export function sanitizeFrontendEvent(
  event: ErrorEvent,
  config: FrontendSentryConfig,
): ErrorEvent | null {
  if (!codes.includes(event.message as FrontendErrorCode)) return null;
  return {
    type: undefined,
    message: event.message,
    level: 'error',
    platform: 'javascript',
    fingerprint: [event.message as string],
    environment: deploymentLabel(config.VITE_SENTRY_ENVIRONMENT),
    release: deploymentLabel(config.VITE_SENTRY_RELEASE),
    ...(event.exception?.values?.[0]?.stacktrace?.frames
      ? {
          exception: {
            values: [
              {
                type: event.message,
                stacktrace: {
                  frames: event.exception.values[0].stacktrace.frames
                    .slice(-20)
                    .flatMap((frame) => {
                      const safe = safeFrame(frame.filename, frame.lineno, frame.colno);
                      return safe ? [safe] : [];
                    }),
                },
              },
            ],
          },
        }
      : {}),
  };
}

/** Explicit opt-in, lazy SDK and bounded anonymous signals; any telemetry failure stays outside the UI. */
export function createFrontendObservability(
  config: FrontendSentryConfig,
  load: () => Promise<SentryPort> = () => import('@sentry/browser'),
) {
  const enabled = config.VITE_SENTRY_ENABLED === 'true' && validDsn(config.VITE_SENTRY_DSN);
  let pending: Promise<void> | undefined;
  let sdk: SentryPort | undefined;
  const queued = new Map<FrontendErrorCode, StackFrame[]>();
  const sent = new Set<FrontendErrorCode>();
  const send = (code: FrontendErrorCode, frames: StackFrame[]): void => {
    if (!enabled || !codes.includes(code) || sent.has(code)) return;
    if (!sdk) {
      queued.set(code, frames);
      return;
    }
    sent.add(code);
    try {
      sdk.captureEvent({
        type: undefined,
        message: code,
        level: 'error',
        ...(frames.length
          ? { exception: { values: [{ type: code, stacktrace: { frames } }] } }
          : {}),
      });
    } catch {
      /* Telemetry must never break recovery. */
    }
  };
  const report = (code: FrontendErrorCode, error?: unknown): void =>
    send(code, sourceFrames(error));
  const onError = (event: globalThis.ErrorEvent) => {
    const frames = sourceFrames(event.error);
    const location = safeFrame(event.filename, event.lineno, event.colno);
    send('UI_UNHANDLED_ERROR', frames.length ? frames : location ? [location] : []);
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    report('UI_UNHANDLED_REJECTION', event.reason);
  const start = (): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(load)
      .then((loaded) => {
        loaded.init({
          dsn: config.VITE_SENTRY_DSN,
          environment: deploymentLabel(config.VITE_SENTRY_ENVIRONMENT),
          release: deploymentLabel(config.VITE_SENTRY_RELEASE),
          defaultIntegrations: false,
          integrations: [],
          sendDefaultPii: false,
          sendClientReports: false,
          enableLogs: false,
          tracesSampleRate: 0,
          beforeSend: (event) => sanitizeFrontendEvent(event, config),
          beforeSendTransaction: () => null,
          transportOptions: {
            fetchOptions: { credentials: 'omit', referrerPolicy: 'no-referrer' },
          },
        });
        sdk = loaded;
        if (typeof window !== 'undefined') {
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onRejection);
        }
        for (const [code, frames] of queued) send(code, frames);
        queued.clear();
      })
      .catch(() => {
        queued.clear();
      });
    return pending;
  };
  const dispose = (): void => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    }
  };
  return { start, report, dispose };
}

const frontend = createFrontendObservability(import.meta.env);
/** Start telemetry without blocking React mounting; disabled builds never import the SDK. */
export const startFrontendObservability = frontend.start;
/** Send a fixed anonymous signal, not the original exception or application state. */
export const reportFrontendError = frontend.report;
