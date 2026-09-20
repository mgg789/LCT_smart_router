import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../common/config';
import type { AiRoleProfile } from '../../generated/prisma/client';
import { LiveService } from '../../orchestrator/live/live.service';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { UnitOfWork } from '../../persistence';
import { AiOperationService } from '../operations';
import type { LlmToolSpec } from '../provider';
import { RunEventBus } from '../runtime/run-event.bus';
import { RunRegistry } from '../runtime/run-registry';
import { StopService } from '../runtime/stop.service';
import { buildClientTools } from './client.tools';
import { buildEngineerTools } from './engineer.tools';
import { buildCallDispatchHelperTool } from './handoff.tool';
import { buildSearchDocumentationTool } from './knowledge.tool';
import { KnowledgeSearchPort } from './knowledge-search.port';
import type { AnyToolSpec } from './tool.types';

/**
 * Which tools a role profile may call.
 *
 * A dispatcher profile currently gets no mutating catalogue of its own -- this change
 * builds the client and engineer catalogues (task boundary); a dispatcher tool catalogue
 * is a later, separate decision, so `catalogueFor('dispatcher_readonly' | 'dispatcher_fix')`
 * returns an empty list rather than reusing another profile's tools it was never asked to
 * expose to a dispatcher's own session.
 */
@Injectable()
export class ToolRegistry {
  private readonly catalogues: Readonly<Record<AiRoleProfile, readonly AnyToolSpec[]>>;

  constructor(
    aiOperations: AiOperationService,
    knowledge: KnowledgeSearchPort,
    requests: RequestsService,
    live: LiveService,
    config: AppConfigService,
    uow: UnitOfWork,
    stop: StopService,
    bus: RunEventBus,
    registry: RunRegistry,
  ) {
    const searchDocumentation = buildSearchDocumentationTool(knowledge);
    const callDispatchHelper = buildCallDispatchHelperTool({ uow, stop, bus, registry });
    const clientTools = buildClientTools({ aiOperations, requests, config });
    const engineerTools = buildEngineerTools({ aiOperations, live, config });

    this.catalogues = {
      client: [...clientTools, searchDocumentation, callDispatchHelper],
      engineer: [...engineerTools, searchDocumentation, callDispatchHelper],
      dispatcher_readonly: [],
      dispatcher_fix: [],
    };
  }

  catalogueFor(profile: AiRoleProfile): readonly AnyToolSpec[] {
    return this.catalogues[profile];
  }

  find(profile: AiRoleProfile, name: string): AnyToolSpec | undefined {
    return this.catalogueFor(profile).find((tool) => tool.name === name);
  }

  /**
   * `AgentRuntimeService.drive()`'s own `tools` array, converted at the provider
   * boundary: `LlmToolSpec.parametersJsonSchema` is plain JSON Schema because the Agents
   * SDK pins zod 3 while this catalogue is authored with this workspace's zod 4
   * (provider/llm.types.ts's own note on why).
   */
  llmSpecsFor(profile: AiRoleProfile): LlmToolSpec[] {
    return this.catalogueFor(profile).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: z.toJSONSchema(tool.schema) as Record<string, unknown>,
    }));
  }

  /** Every tool this registry can ever hand to a model, for the schema-invariant walk
   *  (test/unit/ai-tools.test.ts) -- deduplicated, since `search_documentation` and
   *  `call_dispatch_helper` are shared across profiles. */
  allTools(): readonly AnyToolSpec[] {
    const byName = new Map<string, AnyToolSpec>();
    for (const profile of Object.values(this.catalogues)) {
      for (const tool of profile) {
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  }
}
