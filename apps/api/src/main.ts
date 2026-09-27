import { Observability } from './common/observability/observability';
import 'reflect-metadata';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config';
import { AllExceptionsFilter } from './common/errors';
import { HTTP_CONTRACT } from './common/http-contract';
import { JsonLogger } from './common/logging';
import { BigIntGuardInterceptor } from './common/serialization';
import openApiDocument from './openapi/openapi.json';

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

  app.setGlobalPrefix(HTTP_CONTRACT.prefix, { exclude: HTTP_CONTRACT.exclude });
  app.useGlobalFilters(new AllExceptionsFilter(telemetry.captureError));
  app.useGlobalInterceptors(new BigIntGuardInterceptor(!isProduction));
  app.enableShutdownHooks();

  // The checked-in document is generated from the same Nest routes and runtime Zod
  // schemas used by this process. Do not call createDocument(): decorator reflection
  // cannot see Zod pipes or structural TypeScript return types.
  SwaggerModule.setup('docs', app, openApiDocument as unknown as OpenAPIObject, {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`System Layer listening on port ${port}`);
}

if (require.main === module) {
  void bootstrap();
}
