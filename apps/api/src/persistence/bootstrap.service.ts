import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../common/time';
import type { PrismaClient } from '../generated/prisma/client';
import { APP_STATE_KEYS } from './app-state.keys';
import { PrismaService } from './prisma.service';

/**
 * Creates the singleton rows the system cannot operate without.
 *
 * Only genuine invariants belong here, never demo content: the control mode has to exist
 * and has to be AUTO before anyone switches it, and the service state has to record that
 * the application has not been initialised yet. Loading data is a separate, explicit
 * action (context/37 section 9).
 *
 * Idempotent by construction, so an ordinary restart changes nothing. In particular it
 * must never reset the mode: a restart in MANUAL stays in MANUAL
 * (context/37 section 8).
 *
 * Written as a free function so it can be exercised directly against a test client
 * instead of only as a side effect of booting the application.
 */
export async function ensureSystemInvariants(
  prisma: PrismaClient,
  nowSeconds: number,
): Promise<{ mode: string; modeVersion: number }> {
  const now = BigInt(nowSeconds);

  const control = await prisma.controlState.upsert({
    where: { id: 'singleton' },
    // An existing row is left exactly as it is; the empty update is the whole point.
    update: {},
    create: { id: 'singleton', mode: 'auto', modeVersion: 1, changedAt: now },
  });

  await prisma.appState.upsert({
    where: { key: APP_STATE_KEYS.INITIALIZED },
    update: {},
    create: { key: APP_STATE_KEYS.INITIALIZED, value: false, updatedAt: now },
  });
  await prisma.appState.upsert({
    where: { key: APP_STATE_KEYS.GENERATION },
    update: {},
    create: { key: APP_STATE_KEYS.GENERATION, value: 1, updatedAt: now },
  });

  return { mode: control.mode, modeVersion: control.modeVersion };
}

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    const { mode, modeVersion } = await ensureSystemInvariants(
      this.prisma,
      this.clock.nowSeconds(),
    );
    this.logger.log(`Control mode is ${mode} (version ${modeVersion})`);
  }
}
