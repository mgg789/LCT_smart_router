import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config';
import { AllExceptionsFilter } from './common/errors';
import { JsonLogger } from './common/logging';
import { BigIntGuardInterceptor } from './common/serialization';

async function bootstrap(): Promise<void> {
  const level = (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(level),
    bufferLogs: false,
  });

  const config = app.get(AppConfigService);
  const isProduction = config.isProduction;

  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/services'] });
  app.useGlobalFilters(new AllExceptionsFilter());
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

void bootstrap();
