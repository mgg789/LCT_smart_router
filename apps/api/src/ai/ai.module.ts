import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Global, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import type { Env } from '../common/config/env.schema';
import { HealthRegistry } from '../common/health';
import { Clock } from '../common/time';
import { EngineersModule } from '../orchestrator/engineers';
import { LiveModule } from '../orchestrator/live';
import { RequestsModule } from '../orchestrator/requests';
import { AiHealthProbe } from './ai-health.probe';
import { KnowledgeModule, KnowledgeService } from './knowledge';
import { ActionDecisionGate, ActionGuardService, AiOperationService } from './operations';
import {
  AgentsSdkProvider,
  createDeepseekClient,
  LlmProvider,
  OffProvider,
  OpenAiChatProvider,
  ReplayProvider,
} from './provider';
import {
  AgentRuntimeService,
  AI_FALLBACK_PROVIDER,
  BudgetService,
  ChatEventBus,
  ConversationService,
  DispatchChatsService,
  RunEventBus,
  RunRegistry,
  StopService,
  ToolDispatcher,
} from './runtime';
import { AiToolDispatcher, KnowledgeSearchPort, RoleProfileService, ToolRegistry } from './tools';

type PrimaryProviderKind = Env['LLM_PROVIDER'];
type FallbackProviderKind = Env['LLM_FALLBACK_PROVIDER'];

/**
 * Resolves the replay fixture directory independently of the process working directory.
 *
 * `AI_REPLAY_DIR` is written the way a person reads the repository (`apps/api/test/...`),
 * but the process is not always started from the repository root: `pnpm --filter api start`
 * runs from `apps/api`, the compiled tests run from `dist-test`, and the container runs
 * from its own workdir. A plain relative path therefore resolves differently in each, and
 * the failure is silent -- a missing fixture is the ordinary case for free-typed input, so
 * every lookup would simply miss and the offline contour would answer its honest fallback
 * to everything, never showing a scripted answer. Anchoring on the `api` package root
 * makes the same configured value mean the same directory everywhere.
 */
function resolveReplayDirectory(configured: string): string {
  if (isAbsolute(configured)) {
    return configured;
  }
  let candidate = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(candidate, 'package.json'))) {
      const fromPackage = resolve(candidate, configured);
      if (existsSync(fromPackage)) {
        return fromPackage;
      }
      // The value is written from the repository root (`apps/api/...`); try that too
      // before falling back, so both spellings resolve to the same directory.
      const fromRepoRoot = resolve(candidate, '..', '..', configured);
      if (existsSync(fromRepoRoot)) {
        return fromRepoRoot;
      }
      break;
    }
    candidate = dirname(candidate);
  }
  return resolve(configured);
}

/** Builds the concrete provider for a configured kind. Shared between the primary and
 *  fallback factories below so the two never drift on how a client is constructed. */
function buildProvider(
  kind: PrimaryProviderKind,
  config: AppConfigService,
  clock: Clock,
): LlmProvider {
  switch (kind) {
    case 'off':
      return new OffProvider();
    case 'replay': {
      const directory = resolveReplayDirectory(config.get('AI_REPLAY_DIR'));
      // Logged once, because a wrong directory is otherwise indistinguishable from a
      // corpus of questions nobody recorded an answer for.
      new Logger('AiModule').log(`Replay fixtures resolved to ${directory}`);
      return new ReplayProvider(directory, config.get('AI_REPLAY_SCENARIO'), clock);
    }
    case 'openai_chat':
      return new OpenAiChatProvider(
        createDeepseekClient({
          baseUrl: config.get('LLM_BASE_URL'),
          apiKey: config.get('LLM_TOKEN') ?? '',
          timeoutMs: config.get('LLM_REQUEST_TIMEOUT_MS'),
          proxyToken: config.get('LLM_PROXY_TOKEN'),
        }),
        clock,
      );
    case 'agents':
      return new AgentsSdkProvider(
        createDeepseekClient({
          baseUrl: config.get('LLM_BASE_URL'),
          apiKey: config.get('LLM_TOKEN') ?? '',
          timeoutMs: config.get('LLM_REQUEST_TIMEOUT_MS'),
          proxyToken: config.get('LLM_PROXY_TOKEN'),
        }),
        clock,
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown LLM provider kind: ${String(exhaustive)}`);
    }
  }
}

function buildFallbackProvider(
  kind: FallbackProviderKind,
  config: AppConfigService,
  clock: Clock,
): LlmProvider | null {
  return kind === 'none' ? null : buildProvider(kind, config, clock);
}

/**
 * `AI-gateway` of context/36 section 2, wired the same way `RouterGatewayModule` wires
 * ROUTER-gateway: the configured provider kind selects a concrete implementation, and an
 * unconfigured deployment gets an honest `off` stand-in instead of a missing binding.
 *
 * `RequestsModule`/`EngineersModule`/`LiveModule` are imported so the tool catalogues and
 * the AI action catalogue (`src/ai/operations/ai-action.catalog.ts`) can call the exact
 * same orchestrator services `ClientController`/`EngineerController`/`DispatchController`
 * call -- never a second implementation of a business rule. `AlertsService`,
 * `PolicyService`, `RouterClient`, `AppliedPlanService`, `ControlStateService` and
 * `SnapshotBuilder`/`SnapshotPublisher` reach the dispatcher tool catalogues
 * (`src/ai/tools/dispatcher-read.tools.ts`, `dispatcher-write.tools.ts`) the same way
 * `PrismaService` already reached `AiOperationService` before this change: their owning
 * modules (`AlertsModule`, `PolicyModule`, `RouterGatewayModule`, `MountDataEngModule`,
 * `PersistenceModule`) are all `@Global()` and already loaded by `AppModule`, so no new
 * import is needed here for them.
 *
 * `KnowledgeSearchPort` (src/ai/tools/knowledge-search.port.ts) is bound to the real
 * `KnowledgeService` from `src/ai/knowledge/` -- a parallel piece of work this module
 * only *consumes* through that port, the same way `ToolDispatcher` itself moved from
 * `NoopToolDispatcher` to `AiToolDispatcher` in this change rather than being reimplemented
 * here.
 *
 * Global, because `LlmProvider`, the runtime services and `ToolDispatcher` are needed by
 * `src/api/ai.controller.ts` (a different module) -- the same reasoning `OperationsModule`
 * and `RouterGatewayModule` already apply to their own single, shared instances.
 */
@Global()
@Module({
  imports: [RequestsModule, EngineersModule, LiveModule, KnowledgeModule],
  providers: [
    {
      provide: LlmProvider,
      inject: [AppConfigService, Clock],
      useFactory: (config: AppConfigService, clock: Clock): LlmProvider =>
        buildProvider(config.get('LLM_PROVIDER'), config, clock),
    },
    {
      provide: AI_FALLBACK_PROVIDER,
      inject: [AppConfigService, Clock],
      useFactory: (config: AppConfigService, clock: Clock): LlmProvider | null =>
        buildFallbackProvider(config.get('LLM_FALLBACK_PROVIDER'), config, clock),
    },
    { provide: KnowledgeSearchPort, useExisting: KnowledgeService },
    { provide: ToolDispatcher, useClass: AiToolDispatcher },
    RunRegistry,
    ChatEventBus,
    RunEventBus,
    ConversationService,
    BudgetService,
    StopService,
    DispatchChatsService,
    RoleProfileService,
    ActionGuardService,
    ActionDecisionGate,
    AiOperationService,
    ToolRegistry,
    AgentRuntimeService,
    AiHealthProbe,
  ],
  exports: [
    LlmProvider,
    AI_FALLBACK_PROVIDER,
    ToolDispatcher,
    RunRegistry,
    ChatEventBus,
    RunEventBus,
    ConversationService,
    BudgetService,
    StopService,
    DispatchChatsService,
    RoleProfileService,
    ActionGuardService,
    ActionDecisionGate,
    AiOperationService,
    ToolRegistry,
    AgentRuntimeService,
  ],
})
export class AiModule implements OnModuleInit {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly probe: AiHealthProbe,
  ) {}

  onModuleInit(): void {
    this.registry.register('ai', this.probe);
  }
}
