import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/** Trace the private Router hop without exporting its URL, payload, headers or exception text. */
export async function routerFetch(url: string, init: RequestInit): Promise<Response> {
  if (process.env.OTEL_ENABLED !== 'true') return fetch(url, init);
  return trace
    .getTracer('lct-api')
    .startActiveSpan('Router request', { kind: SpanKind.CLIENT }, async (span) => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      const headers = new Headers(init.headers);
      for (const key of ['traceparent', 'tracestate'])
        if (carrier[key]) headers.set(key, carrier[key]);
      try {
        const response = await fetch(url, { ...init, headers });
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
