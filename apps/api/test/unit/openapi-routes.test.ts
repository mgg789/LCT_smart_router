import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HTTP_CONTRACT } from '../../src/common/http-contract';
import contract from '../../src/openapi/openapi.json';

function controllerFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : controllerFiles(file);
    return entry.name.endsWith('.controller.js') ? [file] : [];
  });
}

function operations(paths: Record<string, object>): string[] {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  return Object.entries(paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

@Module({})
class ContractTestModule {}

test('generated routes match Nest controller discovery without starting business services', async () => {
  const controllers: Type<unknown>[] = controllerFiles(resolve(__dirname, '../../src')).flatMap(
    (file) => {
      const exports: Record<string, unknown> = require(file);
      return Object.values(exports).filter(
        (value): value is Type<unknown> =>
          typeof value === 'function' && Reflect.getMetadata('__controller__', value) === true,
      );
    },
  );
  assert.ok(controllers.length > 0);
  const dependencies = new Set<Type<unknown>>();
  for (const controller of controllers) {
    const types: Type<unknown>[] = Reflect.getMetadata('design:paramtypes', controller) ?? [];
    for (const dependency of types) dependencies.add(dependency);
  }
  // Only controller metadata is under test: no database, email or background workers.
  const app = await NestFactory.create(
    {
      module: ContractTestModule,
      controllers,
      providers: [...dependencies].map((provide) => ({ provide, useValue: {} })),
    },
    { logger: false, abortOnError: false },
  );
  try {
    app.setGlobalPrefix(HTTP_CONTRACT.prefix, { exclude: HTTP_CONTRACT.exclude });
    const discovered = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    assert.deepEqual(operations(contract.paths), operations(discovered.paths));
  } finally {
    await app.close();
  }
});
