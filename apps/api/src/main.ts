import { Observability } from './common/observability/observability';
import 'reflect-metadata';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config';
import { AllExceptionsFilter } from './common/errors';
import { JsonLogger } from './common/logging';
import { BigIntGuardInterceptor } from './common/serialization';

/** Applies the API-only response headers shared by production bootstrap and HTTP tests. */
export function applySecurityHeaders(app: INestApplication, isProduction: boolean): void {
  // The API is proxied by the web server in the deployed contour and does not serve
  // frontend assets itself. Helmet's CSP is disabled here because Swagger UI is an API
  // developer surface with inline bootstrapping; the separate web server owns the
  // frontend CSP. HSTS stays off on local HTTP so browsers remain usable during dev.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? undefined : false,
    }),
  );
}

async function bootstrap(): Promise<void> {
  const level = (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(level),
    bufferLogs: false,
    // Road imports are base64-encoded OSRM resources. Keep this exceptional
    // boundary bounded while allowing the documented 8 MiB decoded upload.
    bodyParser: false,
  });
  const telemetry = app.get(Observability);
  app.use(telemetry.middleware);
  app.useBodyParser('json', { limit: '12mb' });

  const config = app.get(AppConfigService);
  const isProduction = config.isProduction;
  applySecurityHeaders(app, isProduction);

  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/services'] });
  app.useGlobalFilters(new AllExceptionsFilter(telemetry.captureError));
  app.useGlobalInterceptors(new BigIntGuardInterceptor(!isProduction));
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('LCT Smart Router — System Layer')
    .setDescription(
      'System Layer (sys): business state, system operations, snapshot publication for ' +
        'Router Core and application of its result.',
    )
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApi), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`System Layer listening on port ${port}`);
}

if (require.main === module) {
  void bootstrap();
}
