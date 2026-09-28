import { Module } from '@nestjs/common';
import { Observability } from './observability';

/** Optional telemetry lifecycle; configuration is loaded by AppConfigModule first. */
@Module({
  providers: [{ provide: Observability, useFactory: () => Observability.create(process.env) }],
  exports: [Observability],
})
export class ObservabilityModule {}
