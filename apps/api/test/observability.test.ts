import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express, Request, Response } from 'express';
import { Observability, safeRoute } from '../src/common/observability/observability';
import { routerFetch } from '../src/common/observability/router-fetch';

@Module({})
class TestModule {}

async function server(telemetry: Observability, routerTarget?: string) {
  const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
  app.use(telemetry.middleware);
  const express: Express = app.getHttpAdapter().getInstance();
  express.get('/orders/:id', async (_req: Request, res: Response) => {
    if (routerTarget) await routerFetch(routerTarget, {});
    res.status(200).send('ok');
  });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

test('all integrations default off and /metrics is absent', async () => {
  const telemetry = await Observability.create({});
  const { app, url } = await server(telemetry);
  try {
    assert.equal((await fetch(`${url}/metrics`)).status, 404);
    assert.equal((await fetch(`${url}/orders/secret-id`)).status, 200);
    telemetry.captureError(new Error('must not export'));
  } finally {
    await app.close();
    await telemetry.onApplicationShutdown();
  }
});

test('Prometheus exposes bounded route labels and request counts without identifiers', async () => {
  const telemetry = await Observability.create({ METRICS_ENABLED: 'true' });
  const { app, url } = await server(telemetry);
  try {
    await fetch(`${url}/orders/secret-id?token=private`);
    const response = await fetch(`${url}/metrics`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(
      text,
      /lct_api_http_request_duration_seconds_count\{method="GET",route="\/orders\/:id",status="200"\} 1/,
    );
    assert.match(text, /lct_api_process_cpu/);
    assert.doesNotMatch(text, /secret-id|private/);
    assert.equal(safeRoute({}), 'unmatched');
  } finally {
    await app.close();
    await telemetry.onApplicationShutdown();
  }
});

test('enabled OTLP and Sentry deliver sanitized events to real HTTP collectors', async () => {
  const deliveries: Array<{ url: string; body: string; traceparent?: string }> = [];
  const collector = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      deliveries.push({
        url: req.url ?? '',
        body,
        traceparent: req.headers.traceparent as string | undefined,
      });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const port = (collector.address() as AddressInfo).port;
  const telemetry = await Observability.create({
    OTEL_ENABLED: 'true',
    OTEL_TRACE_SAMPLE_RATIO: 1,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: `http://public@127.0.0.1:${port}/1`,
  });
  const previousFlag = process.env.OTEL_ENABLED;
  process.env.OTEL_ENABLED = 'true';
  const { app, url } = await server(telemetry, `http://127.0.0.1:${port}/router`);
  try {
    await fetch(`${url}/orders/private-id?token=secret-token`, {
      headers: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
    });
    telemetry.captureError(new Error('sensitive-error-body'));
    await telemetry.onApplicationShutdown();
    const traces = deliveries.find((item) => item.url === '/v1/traces');
    assert.ok(traces, 'OTLP batch was delivered');
    assert.match(
      deliveries.find((item) => item.url === '/router')?.traceparent ?? '',
      /^00-11111111111111111111111111111111-/,
    );
    assert.match(traces.body, /Router request/);
    assert.match(traces.body, /11111111111111111111111111111111/);
    const sentry = deliveries.find((item) => item.url.startsWith('/api/1/envelope/'));
    assert.ok(sentry, 'Sentry error envelope was delivered');
    assert.match(sentry.body, /API_INTERNAL_ERROR/);
    assert.doesNotMatch(
      deliveries.map((item) => item.body).join(''),
      /private-id|secret-token|sensitive-error-body/,
    );
  } finally {
    await app.close();
    await telemetry.onApplicationShutdown();
    if (previousFlag === undefined) delete process.env.OTEL_ENABLED;
    else process.env.OTEL_ENABLED = previousFlag;
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});
