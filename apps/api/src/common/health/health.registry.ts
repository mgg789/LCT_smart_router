import { Injectable } from '@nestjs/common';
import type { HealthProbe, ServiceHealth } from './health.types';

/**
 * Where feature modules announce the dependencies they own.
 *
 * Registration is late-bound so that a module which is not part of the current build
 * simply never appears, and a module added later replaces its placeholder without the
 * health controller knowing anything about it.
 */
@Injectable()
export class HealthRegistry {
  private readonly probes = new Map<string, HealthProbe>();

  register(name: string, probe: HealthProbe): void {
    this.probes.set(name, probe);
  }

  /** Declares a dependency that exists in the design but is not wired in this build. */
  registerNotConfigured(name: string, detail: string): void {
    if (this.probes.has(name)) {
      return;
    }
    this.probes.set(name, {
      required: false,
      check: () => ({ status: 'not_configured', detail }),
    });
  }

  async checkAll(): Promise<Record<string, ServiceHealth>> {
    const entries = await Promise.all(
      [...this.probes.entries()].map(async ([name, probe]) => {
        try {
          return [name, await probe.check()] as const;
        } catch (error) {
          return [
            name,
            {
              status: 'down' as const,
              detail: error instanceof Error ? error.message : 'probe failed',
            },
          ] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async checkRequired(): Promise<Record<string, ServiceHealth>> {
    const all = await this.checkAll();
    const required = [...this.probes.entries()]
      .filter(([, probe]) => probe.required)
      .map(([name]) => name);
    return Object.fromEntries(
      required.map((name) => [name, all[name] ?? { status: 'down', detail: 'missing probe' }]),
    );
  }
}
