import {
  type AiConnections,
  AiConnectionsService,
} from '../../orchestrator/ai/ai-connections.service';
import type { AiProviderKind, LlmStreamEvent, LlmTurnInput, ProviderOutcome } from './llm.types';
import { LlmProvider } from './llm-provider.port';

/** Rebuilds a live provider only when durable connection settings change. */
export class LiveSettingsProvider extends LlmProvider {
  private provider: LlmProvider;
  private signature = '';
  constructor(
    readonly kind: AiProviderKind,
    private readonly connections: AiConnectionsService,
    private readonly create: (connection: AiConnections['llm']) => LlmProvider,
  ) {
    super();
    this.provider = create(connections.current.llm);
  }
  isConfigured(): boolean {
    return Boolean(this.connections.current.llm.key);
  }
  lastOutcome(): ProviderOutcome {
    return this.provider.lastOutcome();
  }
  async *turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
    const { llm } = await this.connections.read();
    const signature = JSON.stringify(llm);
    if (signature !== this.signature) {
      this.provider = this.create(llm);
      this.signature = signature;
    }
    yield* this.provider.turn({ ...input, model: llm.model });
  }
}
