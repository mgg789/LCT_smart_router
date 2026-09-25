import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../common/config';
import { APP_STATE_KEYS, type Tx } from '../../persistence';
import { PrismaService } from '../../persistence';
import {
  RouterClient,
  type PredictCalibrationDocument,
} from '../../routing/router-gateway';

/**
 * AI contour controls: plan-assessment self-calibration plus reserved connection
 * fields for the future LLM and Jev endpoints.
 *
 * The calibration itself is statistics, not a fitted model: execution facts
 * (started/finished/arrived) directly estimate how wrong the plan's own point
 * estimates were, and Router's simulator consumes the learned dispersion. Below
 * the minimum sample sizes the factory calibration stays — a half-learned model
 * is worse than an honest assumption.
 */

const MIN_SERVICE_SAMPLES = 10;
const FULL_SERVICE_SAMPLES = 50;
const MIN_LEG_SAMPLES = 15;
const FULL_LEG_SAMPLES = 100;
const MIN_CANCEL_REQUESTS = 30;

/** One long leg bucket boundary; short city legs are noisier than highway legs. */
const LEG_LONG_KM = 25;

export interface AiSettingsView {
  readonly planCalibrationEnabled: boolean;
  readonly planCalibrationEnabledRaw: boolean | null;
  readonly llmApiUrl: string | null;
  readonly llmModel: string | null;
  readonly llmApiKeySet: boolean;
  readonly llmApiKeyLast4: string | null;
  readonly jevApiUrl: string | null;
  readonly jevModel: string | null;
  readonly jevApiKeySet: boolean;
  readonly jevApiKeyLast4: string | null;
}

export interface AiCalibrationStatus {
  readonly source: 'factory' | 'learned';
  readonly version: string | null;
  readonly confidence: number;
  readonly samples: {
    readonly service: number;
    readonly legs: number;
    readonly cancelRequests: number;
    readonly executionDays: number;
  };
  readonly computedAt: number | null;
  readonly syncedToRouter: boolean;
}

type StoredAiSettings = {
  planCalibrationEnabled?: boolean | null;
  llmApiUrl?: string | null;
  llmModel?: string | null;
  llmApiKeyLast4?: string | null;
  jevApiUrl?: string | null;
  jevModel?: string | null;
  jevApiKeyLast4?: string | null;
  updatedAt?: number;
};

type CachedCalibration = {
  signature: string;
  computedAt: number;
  confidence: number;
  samples: AiCalibrationStatus['samples'];
  calibration: PredictCalibrationDocument;
  version: string | null;
};

export function factoryCalibrationDocument(): PredictCalibrationDocument {
  return {
    service_cv: 0.3,
    leg_cv_short: 0.3,
    leg_cv_long: 0.1,
    cancel_rate: 0.1,
    source: 'factory',
    learned_from: null,
    regimes: [
      { name: 'normal', probability: 0.65, travel_multiplier: 1.0 },
      { name: 'rain', probability: 0.3, travel_multiplier: 1.12 },
      { name: 'heavy', probability: 0.05, travel_multiplier: 1.25 },
    ],
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private refreshFlight: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: RouterClient,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Settings plus the last calibration reading.
   * Recounting facts and pushing Router stay off this response: that work used
   * to hold the request open, so the switch never flipped and the bar stayed
   * on «Загружаем…».
   */
  async view(): Promise<{ settings: AiSettingsView; status: AiCalibrationStatus }> {
    const stored = await this.readSettings(this.prisma);
    this.scheduleRefresh();
    return this.present(stored);
  }

  /** The document just written inside the caller's transaction, without a second read. */
  async present(
    stored: StoredAiSettings | null,
  ): Promise<{ settings: AiSettingsView; status: AiCalibrationStatus }> {
    const cached = await this.readCache();
    const enabled = stored?.planCalibrationEnabled ?? this.config.isProduction;
    return {
      settings: this.toView(stored),
      status: {
        source: cached?.calibration.source ?? 'factory',
        version: cached?.version ?? null,
        confidence: cached?.confidence ?? 0,
        samples: cached?.samples ?? {
          service: 0,
          legs: 0,
          cancelRequests: 0,
          executionDays: 0,
        },
        computedAt: cached?.computedAt ?? null,
        syncedToRouter: Boolean(enabled && cached?.version),
      },
    };
  }

  /** Starts one calibration pass after the settings transaction has committed. */
  scheduleRefresh(): void {
    this.refreshQueued = true;
    if (this.refreshFlight) return;
    const run = (): void => {
      this.refreshQueued = false;
      this.refreshFlight = this.readSettings(this.prisma)
        .then((stored) => this.status(stored))
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.warn(`Plan calibration refresh failed: ${String(error)}`);
        })
        .finally(() => {
          this.refreshFlight = null;
          if (this.refreshQueued) run();
        });
    };
    run();
  }

  async replace(
    tx: Tx,
    now: number,
    patch: {
      planCalibrationEnabled?: boolean;
      llmApiUrl?: string | null;
      llmModel?: string | null;
      llmApiKey?: string;
      clearLlmApiKey?: boolean;
      jevApiUrl?: string | null;
      jevModel?: string | null;
      jevApiKey?: string;
      clearJevApiKey?: boolean;
    },
  ): Promise<StoredAiSettings> {
    const stored = await this.readSettings(tx);
    const next: StoredAiSettings = { ...stored, updatedAt: now };
    if (patch.planCalibrationEnabled !== undefined) {
      next.planCalibrationEnabled = patch.planCalibrationEnabled;
    }
    if (patch.llmApiUrl !== undefined) next.llmApiUrl = blankToNull(patch.llmApiUrl);
    if (patch.llmModel !== undefined) next.llmModel = blankToNull(patch.llmModel);
    if (patch.clearLlmApiKey) next.llmApiKeyLast4 = null;
    if (patch.llmApiKey) next.llmApiKeyLast4 = patch.llmApiKey.slice(-4);
    if (patch.jevApiUrl !== undefined) next.jevApiUrl = blankToNull(patch.jevApiUrl);
    if (patch.jevModel !== undefined) next.jevModel = blankToNull(patch.jevModel);
    if (patch.clearJevApiKey) next.jevApiKeyLast4 = null;
    if (patch.jevApiKey) next.jevApiKeyLast4 = patch.jevApiKey.slice(-4);
    await tx.appState.upsert({
      where: { key: APP_STATE_KEYS.AI_SETTINGS },
      create: { key: APP_STATE_KEYS.AI_SETTINGS, value: next, updatedAt: BigInt(now) },
      update: { value: next, updatedAt: BigInt(now) },
    });
    return next;
  }

  /** Factory calibration without deleting anything; used by the data reset. */
  async rollbackToFactory(): Promise<boolean> {
    return (await this.push(factoryCalibrationDocument())) !== null;
  }

  private async status(stored: StoredAiSettings | null): Promise<AiCalibrationStatus> {
    const enabled = stored?.planCalibrationEnabled ?? this.config.isProduction;
    const [factsCount, requestsCount] = await Promise.all([
      this.prisma.requestFact.count({
        where: { kind: { in: ['arrived', 'started', 'finished'] } },
      }),
      this.prisma.request.count({ where: { lifecycle: { not: 'draft' } } }),
    ]);
    const signature = `${factsCount}:${requestsCount}`;
    const cached = await this.readCache();
    if (!this.router.isConfigured()) {
      return this.describe(cached, enabled, false);
    }
    if (!enabled) {
      // A disabled contour must not leave learned dispersion behind: the next
      // prediction after the switch goes back to the honest factory assumptions.
      const active = await this.safeActiveSource();
      if (active === 'learned') await this.rollbackToFactory();
      return this.describe(cached, enabled, active === 'learned');
    }
    if (cached && cached.signature === signature) {
      return this.describe(cached, enabled, true);
    }
    const computed = await this.computeFromFacts();
    const pushedVersion = await this.push(computed.calibration);
    if (pushedVersion !== null) {
      const fresh: CachedCalibration = {
        signature,
        computedAt: Date.now(),
        confidence: computed.confidence,
        samples: computed.samples,
        calibration: computed.calibration,
        version: pushedVersion,
      };
      await this.writeCache(fresh);
      return this.describe(fresh, enabled, true);
    }
    return this.describe(cached, enabled, false);
  }

  /** Estimates dispersion from execution facts; below minimums it stays factory. */
  private async computeFromFacts(): Promise<{
    calibration: PredictCalibrationDocument;
    confidence: number;
    samples: AiCalibrationStatus['samples'];
  }> {
    const [facts, requests] = await Promise.all([
      this.prisma.requestFact.findMany({
        where: { kind: { in: ['arrived', 'started', 'finished'] } },
        select: { requestId: true, engineerId: true, kind: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.request.findMany({
        select: {
          id: true,
          serviceDurationSec: true,
          lat: true,
          lon: true,
          lifecycle: true,
        },
      }),
    ]);
    const byId = new Map(requests.map((row) => [row.id, row]));

    // Service: actual duration vs the plan's own duration estimate. The learned
    // number is the residual log-spread, exactly what the simulator multiplies by.
    const logRatios: number[] = [];
    const startedAt = new Map<string, bigint>();
    const finishedDays = new Set<string>();
    for (const fact of facts) {
      if (fact.kind === 'started') {
        startedAt.set(fact.requestId, fact.occurredAt);
        continue;
      }
      if (fact.kind === 'finished') {
        finishedDays.add(new Date(Number(fact.occurredAt) * 1000).toISOString().slice(0, 10));
      }
      const started = startedAt.get(fact.requestId);
      const request = byId.get(fact.requestId);
      if (fact.kind !== 'finished' || started === undefined || !request) continue;
      const actual = Number(fact.occurredAt - started);
      if (actual <= 0 || request.serviceDurationSec <= 0) continue;
      logRatios.push(Math.log(actual / request.serviceDurationSec));
    }

    // Legs: arrived(next) - finished(prev) per engineer, bucketed by distance.
    const legs: Array<{ seconds: number; km: number }> = [];
    const lastFinished = new Map<string, { at: bigint; lat: number | null; lon: number | null }>();
    for (const fact of facts) {
      const request = byId.get(fact.requestId);
      if (!request || !fact.engineerId) continue;
      if (fact.kind === 'finished') {
        lastFinished.set(fact.engineerId, {
          at: fact.occurredAt,
          lat: request.lat,
          lon: request.lon,
        });
        continue;
      }
      if (fact.kind !== 'arrived') continue;
      const previous = lastFinished.get(fact.engineerId);
      if (!previous) continue;
      const seconds = Number(fact.occurredAt - previous.at);
      if (seconds <= 0) continue;
      const km =
        previous.lat != null && previous.lon != null && request.lat != null && request.lon != null
          ? haversineKm(previous.lat, previous.lon, request.lat, request.lon)
          : LEG_LONG_KM;
      legs.push({ seconds, km });
    }

    const serviceSamples = logRatios.length;
    const mean = serviceSamples ? logRatios.reduce((a, b) => a + b, 0) / serviceSamples : 0;
    const variance = serviceSamples
      ? logRatios.reduce((acc, x) => acc + (x - mean) ** 2, 0) / serviceSamples
      : 0;
    const learnedServiceCv = serviceSamples >= MIN_SERVICE_SAMPLES ? Math.sqrt(variance) : null;

    const shortLegs = legs.filter((leg) => leg.km < LEG_LONG_KM).map((leg) => leg.seconds);
    const longLegs = legs.filter((leg) => leg.km >= LEG_LONG_KM).map((leg) => leg.seconds);
    const legCv = (samples: number[]) =>
      samples.length >= MIN_LEG_SAMPLES ? std(samples) / Math.max(1, avg(samples)) : null;

    const considered = requests.filter((row) => row.lifecycle !== 'draft');
    const cancelled = considered.filter((row) => row.lifecycle === 'cancelled').length;
    const learnedCancel =
      considered.length >= MIN_CANCEL_REQUESTS
        ? (cancelled + 1) / (considered.length + 2)
        : null;

    const factory = factoryCalibrationDocument();
    const calibration: PredictCalibrationDocument = {
      service_cv: clamp(learnedServiceCv ?? factory.service_cv, 0, 1),
      leg_cv_short: clamp(legCv(shortLegs) ?? factory.leg_cv_short, 0, 1),
      leg_cv_long: clamp(legCv(longLegs) ?? factory.leg_cv_long, 0, 1),
      cancel_rate: clamp(learnedCancel ?? factory.cancel_rate, 0, 1),
      source: learnedServiceCv === null ? 'factory' : 'learned',
      learned_from: {
        service_samples: serviceSamples,
        leg_samples: legs.length,
        cancel_requests: considered.length,
        execution_days: finishedDays.size,
      },
      regimes: factory.regimes,
    };
    const confidence = Math.min(
      1,
      0.6 * Math.min(1, serviceSamples / FULL_SERVICE_SAMPLES) +
        0.25 * Math.min(1, legs.length / FULL_LEG_SAMPLES) +
        0.15 * Math.min(1, considered.length / FULL_SERVICE_SAMPLES),
    );
    return {
      calibration,
      confidence,
      samples: {
        service: serviceSamples,
        legs: legs.length,
        cancelRequests: considered.length,
        executionDays: finishedDays.size,
      },
    };
  }

  private async describe(
    cached: CachedCalibration | null,
    enabled: boolean,
    synced: boolean,
  ): Promise<AiCalibrationStatus> {
    return {
      source: cached?.calibration.source ?? 'factory',
      version: cached?.version ?? null,
      confidence: cached?.confidence ?? 0,
      samples: cached?.samples ?? {
        service: 0,
        legs: 0,
        cancelRequests: 0,
        executionDays: 0,
      },
      computedAt: cached?.computedAt ?? null,
      syncedToRouter: enabled && synced,
    };
  }

  private async safeActiveSource(): Promise<'factory' | 'learned' | null> {
    try {
      const active = await this.router.getPredictCalibration();
      return active.calibration.source;
    } catch {
      return null;
    }
  }

  /** Pushes one calibration document; returns Router's version or null on failure. */
  private async push(calibration: PredictCalibrationDocument): Promise<string | null> {
    try {
      const result = await this.router.updatePredictCalibration({
        operationId: `ai-calibration-${randomUUID()}`,
        calibration,
      });
      return result.version;
    } catch (error) {
      this.logger.warn(`Predict calibration push failed: ${String(error)}`);
      return null;
    }
  }

  private async readSettings(db: PrismaService | Tx): Promise<StoredAiSettings | null> {
    const row = await db.appState.findUnique({
      where: { key: APP_STATE_KEYS.AI_SETTINGS },
      select: { value: true },
    });
    return row ? (row.value as StoredAiSettings) : null;
  }

  private async readCache(): Promise<CachedCalibration | null> {
    const row = await this.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.AI_CALIBRATION },
      select: { value: true },
    });
    return row ? (row.value as unknown as CachedCalibration) : null;
  }

  private async writeCache(cache: CachedCalibration): Promise<void> {
    const now = Date.now();
    await this.prisma.appState.upsert({
      where: { key: APP_STATE_KEYS.AI_CALIBRATION },
      create: {
        key: APP_STATE_KEYS.AI_CALIBRATION,
        value: cache as unknown as Prisma.InputJsonObject,
        updatedAt: BigInt(now),
      },
      update: {
        value: cache as unknown as Prisma.InputJsonObject,
        updatedAt: BigInt(now),
      },
    });
  }

  private toView(stored: StoredAiSettings | null): AiSettingsView {
    return {
      planCalibrationEnabled: stored?.planCalibrationEnabled ?? this.config.isProduction,
      planCalibrationEnabledRaw: stored?.planCalibrationEnabled ?? null,
      llmApiUrl: stored?.llmApiUrl ?? null,
      llmModel: stored?.llmModel ?? null,
      llmApiKeySet: !!stored?.llmApiKeyLast4,
      llmApiKeyLast4: stored?.llmApiKeyLast4 ?? null,
      jevApiUrl: stored?.jevApiUrl ?? null,
      jevModel: stored?.jevModel ?? null,
      jevApiKeySet: !!stored?.jevApiKeyLast4,
      jevApiKeyLast4: stored?.jevApiKeyLast4 ?? null,
    };
  }
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function avg(samples: number[]): number {
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function std(samples: number[]): number {
  const mean = avg(samples);
  return Math.sqrt(samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / samples.length);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
