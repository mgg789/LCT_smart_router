import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { APP_STATE_KEYS, PrismaService } from '../../persistence';

/** Private connection fields use the same durable AppState storage as map credentials. */
export interface StoredAiConnections {
  llmApiUrl?: string | null;
  llmModel?: string | null;
  llmApiKey?: string | null;
  jevApiUrl?: string | null;
  jevModel?: string | null;
  jevApiKey?: string | null;
}
export interface AiConnections {
  llm: { url: string; model: string; key: string | null };
  jev: { url: string; model: string | null; key: string | null };
}
/** Explicit null credentials disable env fallback; omitted legacy keys still inherit env. */
export function resolveAiConnections(
  stored: StoredAiConnections | null,
  config: AppConfigService,
): AiConnections {
  return {
    llm: {
      url: stored?.llmApiUrl ?? config.get('LLM_BASE_URL'),
      model: stored?.llmModel ?? config.get('LLM_MODEL'),
      key: stored?.llmApiKey !== undefined ? stored.llmApiKey : (config.get('LLM_TOKEN') ?? null),
    },
    jev: {
      url: stored?.jevApiUrl ?? config.get('JEV_API_URL') ?? 'http://host.docker.internal:12444',
      model: stored?.jevModel ?? config.get('JEV_MODEL') ?? null,
      key: stored?.jevApiKey !== undefined ? stored.jevApiKey : (config.get('JEV_API_KEY') ?? null),
    },
  };
}
/** Reads connection overrides at call time; no process-wide environment mutation or restart. */
@Injectable()
export class AiConnectionsService implements OnModuleInit {
  private value: AiConnections;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {
    this.value = resolveAiConnections(null, config);
  }
  /** Last loaded settings for synchronous provider health and run metadata. */
  get current(): AiConnections {
    return this.value;
  }
  async onModuleInit(): Promise<void> {
    await this.read();
  }
  /** Refresh before every external model call, including changes made by another API instance. */
  async read(): Promise<AiConnections> {
    const row = await this.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.AI_SETTINGS },
    });
    this.value = resolveAiConnections(row?.value as StoredAiConnections | null, this.config);
    return this.value;
  }
}
