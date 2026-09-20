import { Injectable } from '@nestjs/common';
import { type Actor, effectiveRoles } from '../../auth';
import { Clock } from '../../common/time';
import type { AiKnowledgeSegment, AiRoleProfile } from '../../generated/prisma/client';
import { APP_STATE_KEYS, PrismaService } from '../../persistence';

type DispatcherAssistMode = 'help' | 'fix';

/**
 * Turns an authenticated actor into the AI role profile that gates its tool catalogue and
 * its visible documents.
 *
 * `forActor` reads `effectiveRoles(actor)` only -- never a conversation row. A conversation
 * carries its own `roleProfile` copied in at open time, which is exactly the value that can
 * go stale: `AiOperationService.confirm` calls `forActor` again at confirm time so that a
 * dispatcher who flipped `fix -> help` between preparing and confirming a card is re-judged
 * against the lane they are in *now*, not the one that happened to be active when the model
 * saw the catalogue (context/35 section 8).
 */
@Injectable()
export class RoleProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async forActor(actor: Actor): Promise<AiRoleProfile> {
    const roles = effectiveRoles(actor);
    if (roles.includes('dispatcher')) {
      const mode = await this.dispatcherAssistMode();
      return mode === 'fix' ? 'dispatcher_fix' : 'dispatcher_readonly';
    }
    if (roles.includes('client')) {
      return 'client';
    }
    if (roles.includes('engineer')) {
      return 'engineer';
    }
    throw new Error('This actor has no role to derive an AI role profile from');
  }

  /**
   * The single dispatcher's current lane (schema.prisma's own comment on `AiAssistMode`).
   * Global, not per-conversation: there is exactly one dispatcher in this deployment
   * (auth/actor.ts's comment on `ApiTokenCategory`), so one durable flag is the correct
   * granularity, and it is what a stale prepared card is re-checked against.
   */
  async dispatcherAssistMode(): Promise<DispatcherAssistMode> {
    const row = await this.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.AI_DISPATCHER_ASSIST_MODE },
    });
    return row?.value === 'fix' ? 'fix' : 'help';
  }

  /** A new dispatcher dialogue always starts read-only; only an explicit request for a
   *  change moves it to `fix` (schema.prisma's own comment on `AiAssistMode`). */
  async setDispatcherAssistMode(mode: DispatcherAssistMode): Promise<void> {
    const now = BigInt(this.clock.nowSeconds());
    await this.prisma.appState.upsert({
      where: { key: APP_STATE_KEYS.AI_DISPATCHER_ASSIST_MODE },
      update: { value: mode, updatedAt: now },
      create: { key: APP_STATE_KEYS.AI_DISPATCHER_ASSIST_MODE, value: mode, updatedAt: now },
    });
  }
}

/**
 * Which knowledge segments and, by the same boundary, which object categories a profile
 * may reach. A dispatcher sees all three app contours; a client or engineer sees only its
 * own (context/35's segment split).
 */
export function segmentsFor(profile: AiRoleProfile): readonly AiKnowledgeSegment[] {
  switch (profile) {
    case 'client':
      return ['client'];
    case 'engineer':
      return ['engineer'];
    case 'dispatcher_readonly':
    case 'dispatcher_fix':
      return ['client', 'engineer', 'dispatcher'];
    default: {
      const exhaustive: never = profile;
      throw new Error(`Unknown AI role profile: ${String(exhaustive)}`);
    }
  }
}
