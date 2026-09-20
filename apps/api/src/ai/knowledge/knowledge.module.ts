import { Global, Module } from '@nestjs/common';
import { KnowledgeIndexerService } from './knowledge.indexer';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge corpus indexer and lexical search, kept apart from the rest of `AiModule` so
 * the retrieval half of the assistant can be built and tested without pulling in the
 * provider/runtime machinery.
 *
 * Global, for the same reason `AiModule` itself is (`src/ai/ai.module.ts`): the tool
 * that calls `KnowledgeService.search` lives in a different module
 * (`src/ai/tools/**`), and that module should not have to import this one by hand to
 * get an instance sys already created once.
 */
@Global()
@Module({
  providers: [KnowledgeService, KnowledgeIndexerService],
  exports: [KnowledgeService, KnowledgeIndexerService],
})
export class KnowledgeModule {}
