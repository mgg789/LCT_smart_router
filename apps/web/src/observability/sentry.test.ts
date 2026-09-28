// @vitest-environment jsdom
import type { BrowserOptions, ErrorEvent } from '@sentry/browser';
import { expect, it, vi } from 'vitest';
import { createFrontendObservability, sanitizeFrontendEvent } from './sentry';

const config = {
  VITE_SENTRY_ENABLED: 'true',
  VITE_SENTRY_DSN: 'https://public@example.test/1',
  VITE_SENTRY_ENVIRONMENT: 'test',
  VITE_SENTRY_RELEASE: 'build-123',
};

it('does not import or initialize the SDK unless explicitly enabled with a valid DSN', async () => {
  for (const settings of [
    {},
    { ...config, VITE_SENTRY_ENABLED: 'false' },
    { ...config, VITE_SENTRY_ENABLED: '1' },
    { ...config, VITE_SENTRY_DSN: '' },
    { ...config, VITE_SENTRY_DSN: 'https://public:secret@example.test/1' },
  ]) {
    const load = vi.fn();
    const telemetry = createFrontendObservability(settings, load);
    await telemetry.start();
    telemetry.report('UI_RENDER_FAILURE');
    expect(load).not.toHaveBeenCalled();
  }
});

it('initializes once, flushes only fixed codes and disables automatic collection', async () => {
  const init = vi.fn<(options: BrowserOptions) => void>();
  const captureEvent = vi.fn();
  const load = vi.fn(async () => ({ init, captureEvent }));
  const telemetry = createFrontendObservability(config, load);
  telemetry.report('UI_RENDER_FAILURE');
  await Promise.all([telemetry.start(), telemetry.start()]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultIntegrations: false,
      integrations: [],
      sendDefaultPii: false,
      sendClientReports: false,
      enableLogs: false,
      tracesSampleRate: 0,
      transportOptions: { fetchOptions: { credentials: 'omit', referrerPolicy: 'no-referrer' } },
    }),
  );
  telemetry.report('UI_RENDER_FAILURE');
  expect(captureEvent).toHaveBeenCalledTimes(1);
  expect(captureEvent).toHaveBeenCalledWith({
    type: undefined,
    message: 'UI_RENDER_FAILURE',
    level: 'error',
  });
  const globalError = new Error('private request');
  globalError.stack = 'Error: private request';
  window.dispatchEvent(
    new ErrorEvent('error', {
      message: 'customer@example.test',
      error: globalError,
    }),
  );
  expect(captureEvent).toHaveBeenLastCalledWith({
    type: undefined,
    message: 'UI_UNHANDLED_ERROR',
    level: 'error',
  });
  telemetry.dispose();
});

it('rebuilds outgoing events without exception details, URLs, business state or identities', () => {
  const event = {
    type: undefined,
    message: 'UI_RENDER_FAILURE',
    exception: { values: [{ value: 'secret' }] },
    request: { url: 'https://example.test?token=secret' },
    user: { email: 'customer@example.test' },
    breadcrumbs: [{ message: 'request 123' }],
    extra: { requestId: 'secret' },
    tags: { engineer: 'secret' },
    contexts: { route: { address: 'secret' } },
    attachments: ['secret'],
  } as unknown as ErrorEvent;
  expect(sanitizeFrontendEvent(event, config)).toEqual({
    type: undefined,
    message: 'UI_RENDER_FAILURE',
    level: 'error',
    platform: 'javascript',
    fingerprint: ['UI_RENDER_FAILURE'],
    environment: 'test',
    release: 'build-123',
  });
  expect(
    sanitizeFrontendEvent({ type: undefined, message: 'customer@example.test' }, config),
  ).toBeNull();
  expect(
    sanitizeFrontendEvent(
      { type: undefined, message: 'UI_RENDER_FAILURE' },
      { ...config, VITE_SENTRY_RELEASE: 'user@example.test' },
    )?.release,
  ).toBeUndefined();
});

it('telemetry loading and reporting failures never propagate to the application', async () => {
  const failed = createFrontendObservability(config, async () => {
    throw new Error('unavailable');
  });
  await expect(failed.start()).resolves.toBeUndefined();
  expect(() => failed.report('UI_RENDER_FAILURE')).not.toThrow();
  const throwing = createFrontendObservability(config, async () => ({
    init: () => undefined,
    captureEvent: () => {
      throw new Error('offline');
    },
  }));
  await throwing.start();
  expect(() => throwing.report('UI_RENDER_FAILURE')).not.toThrow();
  throwing.dispose();
});

it('retains only asset basenames and source positions before the SDK sees render errors', async () => {
  const captureEvent = vi.fn();
  const telemetry = createFrontendObservability(config, async () => ({
    init: () => undefined,
    captureEvent,
  }));
  const error = new Error('customer@example.test request secret');
  error.stack =
    'Error: private\n    at privateName (https://private.example/assets/index-Ab12.js?token=secret:42:7)\n    at other (https://private.example/assets/vendor-X.js:9:3)';
  telemetry.report('UI_RENDER_FAILURE', error);
  await telemetry.start();
  const event = captureEvent.mock.calls[0]?.[0] as ErrorEvent;
  expect(event.exception?.values?.[0]?.stacktrace?.frames).toEqual([
    { filename: 'vendor-X.js', lineno: 9, colno: 3 },
    { filename: 'index-Ab12.js', lineno: 42, colno: 7 },
  ]);
  expect(JSON.stringify(event)).not.toMatch(/private|secret|customer|https/);
  expect(sanitizeFrontendEvent(event, config)?.exception).toEqual(event.exception);
  telemetry.dispose();
});
