import { Module } from '@nestjs/common';
import { AlertResolverService } from './alert-resolver.service';

/**
 * The alert-resolver micro-agent.
 *
 * Not `@Global()`: imported once by `ApiModule`, the only place `AiController` (this
 * module's sole consumer) lives. See `explain.module.ts`'s own note on the same choice,
 * and this change's report for the one-line addition `ai.module.ts` would need to also
 * reach `AlertResolverService` from a future AI tool.
 */
@Module({
  providers: [AlertResolverService],
  exports: [AlertResolverService],
})
export class AlertResolverModule {}
