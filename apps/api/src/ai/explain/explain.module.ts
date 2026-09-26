import { Module } from '@nestjs/common';
import { EvidenceReader } from './evidence.reader';
import { ExplainService } from './explain.service';

/**
 * The explainer micro-agent plus the evidence reader `DispatchController`'s evidence
 * endpoint also needs directly.
 *
 * Not `@Global()`: this module is imported once, by `ApiModule` (where
 * `DispatchController` and `AiController` -- its only consumers -- already live), the
 * same way `ApiModule` already imports `AlertsModule`/`EngineersModule`/etc. If a future
 * AI tool needs `ExplainService` too, importing `ExplainModule` into `ai.module.ts` (and
 * re-exporting it there) is the one additional line -- see this change's report for the
 * exact wiring, deliberately left for that module's owner to add.
 */
@Module({
  providers: [EvidenceReader, ExplainService],
  exports: [EvidenceReader, ExplainService],
})
export class ExplainModule {}
