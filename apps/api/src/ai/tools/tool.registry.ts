import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../common/config';
import type { AiRoleProfile } from '../../generated/prisma/client';
import { AlertsService } from '../../orchestrator/alerts';
import { LiveService } from '../../orchestrator/live/live.service';
import { PolicyService } from '../../orchestrator/policy';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { PrismaService, UnitOfWork } from '../../persistence';
import { SnapshotBuilder } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  RouterClient,
} from '../../routing/router-gateway';
import { AiOperationService } from '../operations';
import type { LlmToolSpec } from '../provider';
import { ChatEventBus } from '../runtime/chat-event.bus';
import { RunEventBus } from '../runtime/run-event.bus';
import { RunRegistry } from '../runtime/run-registry';
import { StopService } from '../runtime/stop.service';
import { buildClientTools } from './client.tools';
import { buildDispatcherReadTools } from './dispatcher-read.tools';
import { buildDispatcherWriteTools } from './dispatcher-write.tools';
import { buildEngineerTools } from './engineer.tools';
import { buildCallDispatchHelperTool } from './handoff.tool';
import { buildSearchDocumentationTool } from './knowledge.tool';
import { KnowledgeSearchPort } from './knowledge-search.port';
import type { AnyToolSpec } from './tool.types';

/**
 * Which tools a role profile may call.
 *
 * `dispatcher_readonly` gets the read catalogue (`dispatcher-read.tools.ts`) plus
 * `search_documentation`; `dispatcher_fix` gets those same read tools plus the preparer
 * catalogue (`dispatcher-write.tools.ts`). A read-only dispatcher never sees a preparer
 * tool at all -- the model cannot call what is not in its own `llmSpecsFor` list -- and
 * even if it somehow did, `AiToolDispatcher.dispatch` would still refuse it through
 * `find(profile, name)` returning nothing, and `AiOperationService.prepare`/`confirm`
 * refuse it again independently by role profile (`ai-action.catalog.ts`'s own
 * `allowedProfiles` on every entry). Three places agree, not one.
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
    chatBus: ChatEventBus,
    prisma: PrismaService,
    plans: AppliedPlanService,
    control: ControlStateService,
    alerts: AlertsService,
    policy: PolicyService,
    router: RouterClient,
    builder: SnapshotBuilder,
  ) {
    const searchDocumentation = buildSearchDocumentationTool(knowledge);
    const callDispatchHelper = buildCallDispatchHelperTool({ uow, stop, bus, registry, chatBus });
    const clientTools = buildClientTools({ aiOperations, requests, config, prisma });
    const engineerTools = buildEngineerTools({ aiOperations, live, config });
    const dispatcherReadTools = buildDispatcherReadTools({
      prisma,
      live,
      plans,
      control,
      requests,
      alerts,
      policy,
      router,
      builder,
    });
    const dispatcherWriteTools = buildDispatcherWriteTools({ aiOperations, config });

    const dispatcherReadonlyTools = [...dispatcherReadTools, searchDocumentation];
    const dispatcherFixTools = [...dispatcherReadonlyTools, ...dispatcherWriteTools];

    this.catalogues = {
      client: [...clientTools, searchDocumentation, callDispatchHelper],
      engineer: [...engineerTools, searchDocumentation, callDispatchHelper],
      dispatcher_readonly: dispatcherReadonlyTools,
      dispatcher_fix: dispatcherFixTools,
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
