import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../common/config';
import { Clock } from '../../common/time';
import type { AiRoleProfile } from '../../generated/prisma/client';
import { AlertsService } from '../../orchestrator/alerts';
import { LiveService } from '../../orchestrator/live/live.service';
import { PassportsService } from '../../orchestrator/passports/passports.service';
import { PolicyService } from '../../orchestrator/policy';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { PrismaService, UnitOfWork } from '../../persistence';
import { SnapshotBuilder } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  PlanRestoreService,
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
import { buildOperationVerificationTool } from './operation-verification.tool';
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
    clock: Clock,
    knowledge: KnowledgeSearchPort,
    requests: RequestsService,
    live: LiveService,
    config: AppConfigService,
    prisma: PrismaService,
    plans: AppliedPlanService,
    restore: PlanRestoreService,
    control: ControlStateService,
    alerts: AlertsService,
    policy: PolicyService,
    router: RouterClient,
    builder: SnapshotBuilder,
    passports: PassportsService,
    uow: UnitOfWork,
    stop: StopService,
    runEvents: RunEventBus,
    runs: RunRegistry,
    chatBus: ChatEventBus,
  ) {
    const searchDocumentation = buildSearchDocumentationTool(knowledge);
    const callDispatchHelper = buildCallDispatchHelperTool({
      uow,
      stop,
      bus: runEvents,
      registry: runs,
      chatBus,
    });
    const clientTools = buildClientTools({ aiOperations, requests, config, prisma });
    const engineerTools = buildEngineerTools({ aiOperations, live, config, passports });
    const dispatcherReadTools = buildDispatcherReadTools({
      prisma,
      live,
      plans,
      restore,
      control,
      requests,
      alerts,
      policy,
      router,
      builder,
      now: () => clock.nowSeconds(),
      timeZone: config.get('APP_TIME_ZONE'),
    });
    const dispatcherWriteTools = buildDispatcherWriteTools({ aiOperations, config });

    const dispatcherReadonlyTools = [
      ...dispatcherReadTools,
      buildOperationVerificationTool(prisma),
      searchDocumentation,
    ];
    const dispatcherFixTools = [...dispatcherReadonlyTools, ...dispatcherWriteTools];

    this.catalogues = {
      /*
       * Both counterparts can put the conversation in front of a human. The tool
       * is theirs alone: a dispatcher asking for a dispatcher is nothing, and the
       * queue it fills is the dispatcher's own «Чаты» tab.
       *
       * It was withheld while that tab was locked and the customer's support
       * screen was a placeholder — the model could have opened a queue nobody was
       * reading. Both now exist, so the escalation the tool was written for is
       * reachable end to end.
       */
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
   *  (test/unit/ai-tools.test.ts) -- deduplicated, since `search_documentation` is
   *  shared across profiles. */
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
