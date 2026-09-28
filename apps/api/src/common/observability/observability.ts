import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { hashToken, secretsMatch } from '../../auth/secrets';

/** Independent opt-in controls; disabled integrations do not require connection settings. */
export const observabilityEnv = {
  METRICS_ENABLED: z.enum(['true', 'false']).default('false'),
  METRICS_TOKEN: z.string().default(''),
  OTEL_ENABLED: z.enum(['true', 'false']).default('false'),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().default('http://otel-collector:4318/v1/traces'),
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_ENABLED: z.enum(['true', 'false']).default('false'),
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_RELEASE: z.string().default(''),
};
const settingsSchema = z.object(observabilityEnv);
type Settings = z.infer<typeof settingsSchema>;

/** Require a header-safe scraper secret only when metrics are explicitly enabled. */
export function validateMetricsConfiguration(options: {
  METRICS_ENABLED: string;
  METRICS_TOKEN: string;
}): void {
  if (options.METRICS_ENABLED !== 'true') return;
  const token = options.METRICS_TOKEN;
  if (
    token.length < 32 ||
    token.length > 512 ||
    /^[A-Za-z0-9._~+/-]+=*$/.exec(token)?.[0] !== token
  ) {
    throw new Error(
      'METRICS_TOKEN must be a 32-512 character bearer token when METRICS_ENABLED=true',
    );
  }
}

/** Reject duplicate headers and partial matches before constant-time comparison of fixed-size hashes. */
function metricsAuthorized(request: Request, expectedHash: Buffer): boolean {
  const count = request.rawHeaders.reduce(
    (total, name, index) =>
      total + (index % 2 === 0 && name.toLowerCase() === 'authorization' ? 1 : 0),
    0,
  );
  const header = request.headers.authorization;
  if (count !== 1 || !header || header.length > 519) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
  const credential = match?.[1];
  return (
    !!match &&
    credential !== undefined &&
    match[0] === header &&
    secretsMatch(Buffer.from(hashToken(credential), 'hex'), expectedHash)
  );
}

/** Never record raw URLs, parameters, query strings, request headers or error messages. */
export function safeRoute(request: { route?: { path?: unknown } }): string {
  const route = request.route?.path;
  return typeof route === 'string' ? route : 'unmatched';
}

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Optional exporters and middleware, owned by the Nest application lifecycle. */
export class Observability {
  middleware: RequestHandler = (_request, _response, next) => next();
  captureError: (error: unknown) => void = () => {};
  private stop: Array<() => Promise<unknown>> = [];

  /** Initialize only enabled SDKs. Batches and timeouts bound exporter overhead. */
  static async create(env: Record<string, unknown>): Promise<Observability> {
    const options: Settings = settingsSchema.parse(env);
    validateMetricsConfiguration(options);
    const metricsTokenHash = Buffer.from(hashToken(options.METRICS_TOKEN), 'hex');
    const result = new Observability();
    const metrics = options.METRICS_ENABLED === 'true' ? await import('prom-client') : null;
    const registry = metrics ? new metrics.Registry() : null;
    if (metrics && registry)
      metrics.collectDefaultMetrics({ register: registry, prefix: 'lct_api_' });
    const duration =
      metrics && registry
        ? new metrics.Histogram({
            name: 'lct_api_http_request_duration_seconds',
            help: 'HTTP request duration in seconds',
            labelNames: ['method', 'route', 'status'] as const,
            buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 30],
            registers: [registry],
          })
        : null;
    let otel: typeof import('@opentelemetry/api') | null = null;
    if (options.OTEL_ENABLED === 'true') {
      const endpoint = new URL(options.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
      if (!['http:', 'https:'].includes(endpoint.protocol))
        throw new Error('Invalid OTLP endpoint protocol');
      const [
        { NodeSDK },
        { OTLPTraceExporter },
        { resourceFromAttributes },
        { TraceIdRatioBasedSampler, ParentBasedSampler },
      ] = await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/sdk-trace-node'),
      ]);
      otel = await import('@opentelemetry/api');
      const sdk = new NodeSDK({
        autoDetectResources: false,
        resource: resourceFromAttributes({ 'service.name': 'lct-api' }),
        sampler: new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(options.OTEL_TRACE_SAMPLE_RATIO),
        }),
        traceExporter: new OTLPTraceExporter({ url: endpoint.href, timeoutMillis: 2000 }),
        metricReaders: [],
        logRecordProcessors: [],
        instrumentations: [],
      });
      sdk.start();
      result.stop.push(() => sdk.shutdown());
    }
    if (options.SENTRY_ENABLED === 'true') {
      if (!options.SENTRY_DSN) throw new Error('SENTRY_DSN is required when SENTRY_ENABLED=true');
      const sentry = await import('@sentry/node');
      sentry.init({
        dsn: options.SENTRY_DSN,
        environment: options.SENTRY_ENVIRONMENT,
        release: options.SENTRY_RELEASE || undefined,
        defaultIntegrations: false,
        sendDefaultPii: false,
        skipOpenTelemetrySetup: true,
        beforeSend: (event) => ({
          type: undefined,
          event_id: event.event_id,
          timestamp: event.timestamp,
          platform: 'node',
          level: 'error',
          environment: options.SENTRY_ENVIRONMENT,
          release: options.SENTRY_RELEASE || undefined,
          exception: {
            values: [
              {
                type: 'ServerError',
                value: 'API_INTERNAL_ERROR',
                stacktrace: {
                  frames: event.exception?.values?.[0]?.stacktrace?.frames?.map((frame) => ({
                    filename: frame.filename?.split('?')[0]?.split('/').pop(),
                    function: frame.function,
                    lineno: frame.lineno,
                    colno: frame.colno,
                    in_app: frame.in_app,
                  })),
                },
              },
            ],
          },
        }),
      });
      result.captureError = (error) => {
        sentry.captureException(error instanceof Error ? error : new Error('API_INTERNAL_ERROR'));
      };
      result.stop.push(() => sentry.close(2000));
    }
    result.middleware = (request, response, next) => {
      if (request.path === '/metrics') {
        if (!registry) {
          response.sendStatus(404);
          return;
        }
        if (request.method !== 'GET') {
          response.sendStatus(405);
          return;
        }
        if (!metricsAuthorized(request, metricsTokenHash)) {
          response.set('WWW-Authenticate', 'Bearer').sendStatus(401);
          return;
        }
        void registry
          .metrics()
          .then((body) => response.type(registry.contentType).send(body))
          .catch(() => response.sendStatus(503));
        return;
      }
      if (!duration && !otel) {
        next();
        return;
      }
      const method = methods.has(request.method) ? request.method : 'OTHER';
      const start = performance.now();
      const parent = otel?.propagation.extract(otel.context.active(), {
        traceparent: request.headers.traceparent,
        tracestate: request.headers.tracestate,
      });
      const span = otel?.trace
        .getTracer('lct-api')
        .startSpan('HTTP request', { kind: otel.SpanKind.SERVER }, parent);
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        const route = safeRoute(request);
        const status = response.writableFinished ? response.statusCode : 499;
        duration?.observe(
          { method, route, status: String(status) },
          (performance.now() - start) / 1000,
        );
        span?.updateName(`${method} ${route}`);
        span?.setAttributes({
          'http.request.method': method,
          'http.route': route,
          'http.response.status_code': status,
        });
        if (status >= 500 && otel) span?.setStatus({ code: otel.SpanStatusCode.ERROR });
        span?.end();
      };
      response.once('finish', finish);
      response.once('close', finish);
      if (otel && span)
        otel.context.with(otel.trace.setSpan(parent ?? otel.context.active(), span), next);
      else next();
    };
    return result;
  }

  /** Nest calls this after accepting no more HTTP connections. Export failures do not block exit. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.stop.map((stop) => stop()));
    this.stop = [];
  }
}
