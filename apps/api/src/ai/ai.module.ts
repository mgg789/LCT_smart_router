import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import type { Env } from '../common/config/env.schema';
import { HealthRegistry } from '../common/health';
import { Clock } from '../common/time';
import { AiHealthProbe } from './ai-health.probe';
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
  ConversationService,
  NoopToolDispatcher,
  RunEventBus,
  RunRegistry,
  StopService,
  ToolDispatcher,
} from './runtime';

type PrimaryProviderKind = Env['LLM_PROVIDER'];
type FallbackProviderKind = Env['LLM_FALLBACK_PROVIDER'];

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
    case 'replay':
      return new ReplayProvider(
        config.get('AI_REPLAY_DIR'),
        config.get('AI_REPLAY_SCENARIO'),
        clock,
      );
    case 'openai_chat':
      return new OpenAiChatProvider(
        createDeepseekClient({
          baseUrl: config.get('LLM_BASE_URL'),
          apiKey: config.get('LLM_TOKEN') ?? '',
          timeoutMs: config.get('LLM_REQUEST_TIMEOUT_MS'),
        }),
        clock,
      );
    case 'agents':
      return new AgentsSdkProvider(
        createDeepseekClient({
          baseUrl: config.get('LLM_BASE_URL'),
          apiKey: config.get('LLM_TOKEN') ?? '',
          timeoutMs: config.get('LLM_REQUEST_TIMEOUT_MS'),
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
 * Global, because `LlmProvider`, the runtime services and `ToolDispatcher` are needed by
 * `src/api/ai.controller.ts` (a different module) and by whichever later module adds the
 * real tool catalogue -- the same reasoning `OperationsModule` and `RouterGatewayModule`
 * already apply to their own single, shared instances.
 */
@Global()
@Module({
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
    { provide: ToolDispatcher, useClass: NoopToolDispatcher },
    RunRegistry,
    RunEventBus,
    ConversationService,
    BudgetService,
    StopService,
    AgentRuntimeService,
    AiHealthProbe,
  ],
  exports: [
    LlmProvider,
    AI_FALLBACK_PROVIDER,
    ToolDispatcher,
    RunRegistry,
    RunEventBus,
    ConversationService,
    BudgetService,
    StopService,
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
