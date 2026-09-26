import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { Prisma } from '../../generated/prisma/client';
import {
  APP_STATE_KEYS,
  lockWorkingSetGeneration,
  PrismaService,
  type Tx,
} from '../../persistence';
import { type PredictCalibrationDocument, RouterClient } from '../../routing/router-gateway';
import { WeatherDayCacheService, weatherLocationHash } from './weather-day-cache.service';
import {
  calibrateWeatherRegimes,
  fitWeatherCandidates,
  type WeatherCalibrationCandidate,
  type WeatherCalibrationCoverage,
  type WeatherLegObservation,
  type WeatherRiskValidation,
} from './weather-regime-calibration';

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
  readonly weatherCalibration: WeatherCalibrationCoverage;
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
  weatherCalibration: WeatherCalibrationCoverage;
  weatherCandidates: ReadonlyArray<WeatherCalibrationCandidate>;
};

export function factoryCalibrationDocument(workingSetGeneration = 1): PredictCalibrationDocument {
  return {
    working_set_generation: workingSetGeneration,
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
    weather_multipliers: [],
  };
}

function emptyWeatherCalibration(): WeatherCalibrationCoverage {
  return {
    status: 'factory',
    observationCount: 0,
    days: 0,
    eligibleGroups: 0,
    totalGroups: 0,
    version: null,
    source: 'travel_elapsed_proxy',
    uncertainty: 'not_estimated',
    reason: 'Нет сопоставленных наблюдений о погоде и поездках.',
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
    private readonly weatherCache: WeatherDayCacheService,
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
        weatherCalibration: cached?.weatherCalibration ?? emptyWeatherCalibration(),
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
    await lockWorkingSetGeneration(tx);
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
    return this.prisma.$transaction(async (tx) => {
      await lockWorkingSetGeneration(tx);
      const generation = await tx.appState.findUnique({
        where: { key: APP_STATE_KEYS.GENERATION },
        select: { value: true },
      });
      let active: Awaited<ReturnType<RouterClient['getPredictCalibration']>> | null = null;
      try {
        active = await this.router.getPredictCalibration();
      } catch {
        // Optional clients may throw synchronously; reset still completes offline.
      }
      return (
        (await this.push(
          factoryCalibrationDocument(typeof generation?.value === 'number' ? generation.value : 1),
          active?.version,
        )) !== null
      );
    });
  }

  /** Returns the frozen shadow candidate as an internal prediction-only override. */
  async weatherShadowOverride(): Promise<{
    candidates: ReadonlyArray<WeatherCalibrationCandidate>;
    calibration: PredictCalibrationDocument;
  } | null> {
    const settings = await this.readSettings(this.prisma);
    if (!(settings?.planCalibrationEnabled ?? this.config.isProduction)) return null;
    const cache = await this.readCache();
    if (!cache?.weatherCandidates.length) return null;
    const base = await this.router.getPredictCalibration().catch(() => null);
    const calibration = base?.calibration ?? factoryCalibrationDocument();
    return {
      candidates: cache.weatherCandidates,
      calibration: {
        ...calibration,
        weather_multipliers: cache.weatherCandidates.map((candidate) => ({
          region: candidate.region,
          transport_type: candidate.transport_type,
          kind: candidate.kind,
          multiplier: candidate.multiplier,
          source: 'learned',
          observations: candidate.observations,
          days: candidate.days,
          baseline_travel_error: 0,
          candidate_travel_error: 0,
          baseline_brier: 0,
          candidate_brier: 0,
          validation_version: candidate.candidate_version,
        })),
      },
    };
  }

  /** Persists pre-finish paired risk predictions; a later confirmed fact supplies labels. */
  async recordWeatherRiskPredictions(
    expectedGeneration: string,
    rows: ReadonlyArray<{
      planId: string;
      requestId: string;
      engineerId: string;
      region: string;
      transportType: 'car' | 'walk' | 'bike' | 'transit';
      weatherKind: 'rain' | 'snow' | 'storm';
      workDate: string;
      candidateVersion: string;
      inputHash: string;
      routerContextVersion: string;
      predictedAt: number;
      baselineProbability: number;
      candidateProbability: number;
      breachAfterAt: number;
    }>,
  ): Promise<void> {
    if (!rows.length) return;
    await this.prisma.$transaction(async (tx) => {
      await lockWorkingSetGeneration(tx);
      const state = await tx.appState.findUnique({
        where: { key: APP_STATE_KEYS.GENERATION },
        select: { value: true },
      });
      if (String(state?.value ?? 1) !== expectedGeneration) return;
      await tx.weatherRiskPrediction.createMany({
        data: rows.map((row) => ({
          ...row,
          predictedAt: BigInt(row.predictedAt),
          breachAfterAt: BigInt(row.breachAfterAt),
        })),
        skipDuplicates: true,
      });
    });
  }

  async currentWorkingSetGeneration(): Promise<string> {
    const state = await this.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.GENERATION },
      select: { value: true },
    });
    return String(state?.value ?? 1);
  }

  /** Enforces a committed disable even while asynchronous Router rollback is unavailable. */
  async predictionCalibrationOverride(
    generation: number,
  ): Promise<PredictCalibrationDocument | null> {
    const settings = await this.readSettings(this.prisma);
    return (settings?.planCalibrationEnabled ?? this.config.isProduction)
      ? null
      : factoryCalibrationDocument(generation);
  }

  private async status(stored: StoredAiSettings | null): Promise<AiCalibrationStatus> {
    const enabled = stored?.planCalibrationEnabled ?? this.config.isProduction;
    const signature = await this.dataSignature();
    const cached = await this.readCache();
    if (!enabled) {
      // A disabled contour must not leave learned dispersion behind: the next
      // prediction after the switch goes back to the honest factory assumptions.
      const active = await this.safeActiveSource();
      const synced = active !== 'learned' || (await this.rollbackToFactory());
      if (cached) await this.invalidateCalibrationCache();
      return this.describe(null, enabled, synced);
    }
    if (!this.router.isConfigured()) {
      return this.describe(cached, enabled, false);
    }
    if (cached && cached.signature === signature) {
      return this.describe(cached, enabled, true);
    }
    const active = await this.router.getPredictCalibration().catch(() => null);
    const computed = await this.computeFromFacts(cached, signature);
    if ((await this.dataSignature()) !== signature) {
      this.scheduleRefresh();
      return this.describe(cached, enabled, false);
    }
    const fresh = await this.prisma.$transaction(async (tx) => {
      await lockWorkingSetGeneration(tx);
      const currentSettings = await this.readSettings(tx);
      if (!(currentSettings?.planCalibrationEnabled ?? this.config.isProduction)) return null;
      if ((await this.dataSignature(tx)) !== signature) return null;
      const pushedVersion = await this.push(computed.calibration, active?.version);
      if (pushedVersion === null) return null;
      const cache: CachedCalibration = {
        signature,
        computedAt: Date.now(),
        confidence: computed.confidence,
        samples: computed.samples,
        calibration: computed.calibration,
        version: pushedVersion,
        weatherCalibration: computed.weatherCalibration,
        weatherCandidates: computed.weatherCandidates,
      };
      await tx.appState.upsert({
        where: { key: APP_STATE_KEYS.AI_CALIBRATION },
        create: {
          key: APP_STATE_KEYS.AI_CALIBRATION,
          value: cache as unknown as Prisma.InputJsonObject,
          updatedAt: BigInt(Date.now()),
        },
        update: {
          value: cache as unknown as Prisma.InputJsonObject,
          updatedAt: BigInt(Date.now()),
        },
      });
      return cache;
    });
    if (fresh) {
      return this.describe(fresh, enabled, true);
    }
    return this.describe(cached, enabled, false);
  }

  private async dataSignature(db: PrismaService | Tx = this.prisma): Promise<string> {
    const [facts, requests, cancelled, weatherRows, riskRows, generation] = await Promise.all([
      db.requestFact.count({ where: { kind: { in: ['arrived', 'started', 'finished'] } } }),
      db.request.count({ where: { lifecycle: { not: 'draft' } } }),
      db.request.count({ where: { lifecycle: 'cancelled' } }),
      db.weatherDayCache.findMany({
        select: { region: true, workDate: true, locationHash: true, weatherCode: true, kind: true },
        orderBy: [{ region: 'asc' }, { workDate: 'asc' }],
      }),
      db.weatherRiskPrediction.findMany({
        select: {
          planId: true,
          requestId: true,
          candidateVersion: true,
          region: true,
          transportType: true,
          weatherKind: true,
          workDate: true,
          inputHash: true,
          predictedAt: true,
          baselineProbability: true,
          candidateProbability: true,
          actualBreach: true,
          resolvedAt: true,
        },
        orderBy: [{ planId: 'asc' }, { requestId: 'asc' }, { candidateVersion: 'asc' }],
      }),
      db.appState.findUnique({
        where: { key: APP_STATE_KEYS.GENERATION },
        select: { value: true },
      }),
    ]);
    const weatherFingerprint = createHash('sha256')
      .update(JSON.stringify(weatherRows))
      .digest('hex');
    const riskFingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          riskRows.map((row) => ({
            ...row,
            predictedAt: String(row.predictedAt),
            resolvedAt: row.resolvedAt === null ? null : String(row.resolvedAt),
          })),
        ),
      )
      .digest('hex');
    return `${String(generation?.value ?? 1)}:${facts}:${requests}:${cancelled}:${weatherFingerprint}:${riskFingerprint}`;
  }

  /** Estimates dispersion from execution facts; below minimums it stays factory. */
  private async computeFromFacts(
    previous: CachedCalibration | null,
    signature: string,
  ): Promise<{
    calibration: PredictCalibrationDocument;
    confidence: number;
    samples: AiCalibrationStatus['samples'];
    weatherCalibration: WeatherCalibrationCoverage;
    weatherCandidates: ReadonlyArray<WeatherCalibrationCandidate>;
  }> {
    const [facts, requests] = await Promise.all([
      this.prisma.requestFact.findMany({
        where: { kind: { in: ['arrived', 'started', 'finished'] } },
        select: {
          id: true,
          requestId: true,
          engineerId: true,
          kind: true,
          occurredAt: true,
          metadata: true,
        },
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
      considered.length >= MIN_CANCEL_REQUESTS ? (cancelled + 1) / (considered.length + 2) : null;

    const workingSetGeneration = Number(signature.split(':')[0]);
    const factory = factoryCalibrationDocument(
      Number.isSafeInteger(workingSetGeneration) ? workingSetGeneration : 1,
    );
    const weatherLegObservations = await this.readWeatherLegObservations(facts);
    await this.resolveWeatherRiskOutcomes(facts);
    const fittedCandidates = fitWeatherCandidates(weatherLegObservations);
    const frozenByGroup = new Map(
      (previous?.weatherCandidates ?? []).map((candidate) => [
        `${candidate.region}\u0000${candidate.transport_type}\u0000${candidate.kind}`,
        candidate,
      ]),
    );
    for (const candidate of fittedCandidates) {
      const key = `${candidate.region}\u0000${candidate.transport_type}\u0000${candidate.kind}`;
      if (!frozenByGroup.has(key)) frozenByGroup.set(key, candidate);
    }
    const weatherCandidates = [...frozenByGroup.values()];
    const riskRows = await this.prisma.weatherRiskPrediction.findMany({
      where: { actualBreach: { not: null } },
      select: {
        region: true,
        transportType: true,
        weatherKind: true,
        workDate: true,
        baselineProbability: true,
        candidateProbability: true,
        actualBreach: true,
        candidateVersion: true,
      },
    });
    const risks: WeatherRiskValidation[] = riskRows.flatMap((row) => {
      if (!isCalibrationWeatherKind(row.weatherKind) || row.actualBreach === null) return [];
      return [
        {
          region: row.region,
          transport: row.transportType,
          kind: row.weatherKind,
          workDate: row.workDate,
          baselineProbability: row.baselineProbability,
          candidateProbability: row.candidateProbability,
          actualBreach: row.actualBreach,
          candidateVersion: row.candidateVersion,
        },
      ];
    });
    const weatherResult = calibrateWeatherRegimes(weatherLegObservations, risks, weatherCandidates);
    const calibration: PredictCalibrationDocument = {
      service_cv: clamp(learnedServiceCv ?? factory.service_cv, 0, 1),
      leg_cv_short: clamp(legCv(shortLegs) ?? factory.leg_cv_short, 0, 1),
      leg_cv_long: clamp(legCv(longLegs) ?? factory.leg_cv_long, 0, 1),
      cancel_rate: clamp(learnedCancel ?? factory.cancel_rate, 0, 1),
      source:
        learnedServiceCv === null &&
        learnedCancel === null &&
        weatherResult.multipliers.length === 0
          ? 'factory'
          : 'learned',
      working_set_generation: factory.working_set_generation,
      learned_from: {
        service_samples: serviceSamples,
        leg_samples: legs.length,
        cancel_requests: considered.length,
        execution_days: finishedDays.size,
      },
      regimes: factory.regimes,
      weather_multipliers: weatherResult.multipliers,
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
      weatherCalibration: weatherResult.coverage,
      weatherCandidates,
    };
  }

  private async readWeatherLegObservations(
    facts: Array<{
      id: string;
      requestId: string;
      engineerId: string | null;
      kind: string;
      occurredAt: bigint;
      metadata: unknown;
    }>,
  ): Promise<WeatherLegObservation[]> {
    const captures = facts.flatMap((fact) => {
      if (fact.kind !== 'finished' || !fact.engineerId) return [];
      const calibration = nestedObject(fact.metadata, 'weatherCalibration');
      const region = stringField(calibration, 'region');
      const workDate = stringField(calibration, 'workDate');
      return region && workDate ? [{ fact, calibration, region, workDate }] : [];
    });
    const regions = [...new Set(captures.map((row) => row.region))];
    const depots = regions.length
      ? await this.prisma.depot.findMany({
          where: { region: { in: regions }, lat: { not: null }, lon: { not: null } },
          select: { region: true, lat: true, lon: true },
        })
      : [];
    const centerByRegion = new Map(
      depots.flatMap((row) =>
        row.lat !== null && row.lon !== null
          ? [[row.region, { lat: row.lat, lon: row.lon }] as const]
          : [],
      ),
    );
    const datesByRegion = new Map<string, Set<string>>();
    for (const { region, workDate } of captures) {
      const dates = datesByRegion.get(region) ?? new Set<string>();
      dates.add(workDate);
      datesByRegion.set(region, dates);
    }
    await Promise.all(
      [...datesByRegion].map(async ([region, dates]) => {
        const center = centerByRegion.get(region);
        if (center) await this.weatherCache.fillMissing(region, center.lat, center.lon, [...dates]);
      }),
    );

    const keys = [
      ...new Map(captures.map((row) => [`${row.region}\u0000${row.workDate}`, row])).values(),
    ];
    const weatherRows = keys.length
      ? await this.prisma.weatherDayCache.findMany({
          where: {
            OR: keys.flatMap((row) => {
              const center = centerByRegion.get(row.region);
              return center
                ? [
                    {
                      region: row.region,
                      workDate: row.workDate,
                      locationHash: weatherLocationHash(center.lat, center.lon),
                    },
                  ]
                : [];
            }),
          },
          select: { region: true, workDate: true, kind: true },
        })
      : [];
    const weatherByKey = new Map(
      weatherRows.map((row) => [`${row.region}\u0000${row.workDate}`, row.kind]),
    );
    const engineerIds = [
      ...new Set(captures.flatMap((row) => (row.fact.engineerId ? [row.fact.engineerId] : []))),
    ];
    const dates = [...new Set(captures.map((row) => row.workDate))];
    const workdays =
      engineerIds.length && dates.length
        ? await this.prisma.engineerDay.findMany({
            where: { engineerId: { in: engineerIds }, workDate: { in: dates }, lunchTaken: true },
            select: { engineerId: true, workDate: true, lunchStartedAt: true },
          })
        : [];
    const lunchByEngineerDay = new Map(
      workdays.map((row) => [`${row.engineerId}\u0000${row.workDate}`, row.lunchStartedAt]),
    );
    const output: WeatherLegObservation[] = [];
    for (const capture of captures) {
      const { fact, calibration, region, workDate } = capture;
      const engineerId = fact.engineerId;
      if (!engineerId) continue;
      const planId = stringField(calibration, 'planId');
      const nextRequestId = stringField(calibration, 'nextRequestId');
      const transport = stringField(calibration, 'transport');
      const canonicalSec = numberField(calibration, 'canonicalSec');
      const weatherKind = weatherByKey.get(`${region}\u0000${workDate}`);
      if (
        !planId ||
        !nextRequestId ||
        !canonicalSec ||
        !transport ||
        !isCalibrationTransport(transport) ||
        !isCalibrationWeatherKind(weatherKind)
      )
        continue;
      const arrival = facts.find((candidate) => {
        if (
          candidate.kind !== 'arrived' ||
          candidate.requestId !== nextRequestId ||
          candidate.engineerId !== engineerId ||
          candidate.occurredAt <= fact.occurredAt
        )
          return false;
        const arrivalCalibration = nestedObject(candidate.metadata, 'weatherCalibration');
        return (
          stringField(arrivalCalibration, 'planId') === planId &&
          stringField(arrivalCalibration, 'workDate') === workDate
        );
      });
      if (!arrival) continue;
      const interruption = facts.some(
        (candidate) =>
          candidate.engineerId === engineerId &&
          candidate.occurredAt > fact.occurredAt &&
          candidate.occurredAt < arrival.occurredAt &&
          !(
            candidate.id === arrival.id &&
            candidate.kind === 'arrived' &&
            candidate.requestId === nextRequestId
          ),
      );
      if (interruption) continue;
      const lunchAt = lunchByEngineerDay.get(`${engineerId}\u0000${workDate}`);
      if (
        lunchAt !== undefined &&
        lunchAt !== null &&
        lunchAt > fact.occurredAt &&
        lunchAt < arrival.occurredAt
      )
        continue;
      const actualSec = Number(arrival.occurredAt - fact.occurredAt);
      if (!Number.isSafeInteger(actualSec) || actualSec <= 0) continue;
      output.push({ region, transport, kind: weatherKind, workDate, actualSec, canonicalSec });
    }
    return output;
  }

  /** Joins only later confirmed finishes from the same immutable plan and weather day. */
  private async resolveWeatherRiskOutcomes(
    facts: Array<{
      requestId: string;
      engineerId: string | null;
      kind: string;
      occurredAt: bigint;
      metadata: unknown;
    }>,
  ): Promise<void> {
    const pending = await this.prisma.weatherRiskPrediction.findMany({
      where: { actualBreach: null },
      select: {
        planId: true,
        requestId: true,
        engineerId: true,
        region: true,
        weatherKind: true,
        workDate: true,
        predictedAt: true,
        breachAfterAt: true,
        candidateVersion: true,
      },
    });
    if (!pending.length) return;
    const depots = await this.prisma.depot.findMany({
      where: {
        region: { in: [...new Set(pending.map((row) => row.region))] },
        lat: { not: null },
        lon: { not: null },
      },
      select: { region: true, lat: true, lon: true },
    });
    const locationByRegion = new Map(
      depots.flatMap((row) =>
        row.lat !== null && row.lon !== null
          ? [[row.region, weatherLocationHash(row.lat, row.lon)] as const]
          : [],
      ),
    );
    const cache = await this.prisma.weatherDayCache.findMany({
      where: { OR: pending.map(({ region, workDate }) => ({ region, workDate })) },
      select: { region: true, workDate: true, locationHash: true, kind: true },
    });
    const weatherByKey = new Map(
      cache.map((row) => [
        `${row.region}\u0000${row.workDate}`,
        row.locationHash === locationByRegion.get(row.region) ? row.kind : null,
      ]),
    );
    for (const prediction of pending) {
      if (
        !isCalibrationWeatherKind(prediction.weatherKind) ||
        weatherByKey.get(`${prediction.region}\u0000${prediction.workDate}`) !==
          prediction.weatherKind
      )
        continue;
      const finish = facts.find((fact) => {
        if (
          fact.kind !== 'finished' ||
          fact.requestId !== prediction.requestId ||
          fact.engineerId !== prediction.engineerId ||
          fact.occurredAt <= prediction.predictedAt
        )
          return false;
        const metadata = nestedObject(fact.metadata, 'weatherCalibration');
        return (
          stringField(metadata, 'planId') === prediction.planId &&
          stringField(metadata, 'workDate') === prediction.workDate
        );
      });
      if (!finish) continue;
      await this.prisma.weatherRiskPrediction.updateMany({
        where: {
          planId: prediction.planId,
          requestId: prediction.requestId,
          candidateVersion: prediction.candidateVersion,
          actualBreach: null,
        },
        data: {
          actualBreach: finish.occurredAt > prediction.breachAfterAt,
          resolvedAt: finish.occurredAt,
        },
      });
    }
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
      weatherCalibration: cached?.weatherCalibration ?? emptyWeatherCalibration(),
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
  private async push(
    calibration: PredictCalibrationDocument,
    expectedVersion?: string,
  ): Promise<string | null> {
    try {
      const result = await this.router.updatePredictCalibration({
        operationId: `ai-calibration-${randomUUID()}`,
        ...(expectedVersion ? { expectedVersion } : {}),
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

  /** Drops frozen candidates when calibration is disabled so re-enabling recomputes them. */
  private async invalidateCalibrationCache(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockWorkingSetGeneration(tx);
      await tx.appState.deleteMany({ where: { key: APP_STATE_KEYS.AI_CALIBRATION } });
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

function nestedObject(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === 'object' && child !== null && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) && field > 0 ? field : null;
}

function isCalibrationTransport(value: string): value is 'car' | 'walk' | 'bike' | 'transit' {
  return value === 'car' || value === 'walk' || value === 'bike' || value === 'transit';
}

function isCalibrationWeatherKind(
  value: string | null | undefined,
): value is 'clear' | 'cloud' | 'rain' | 'snow' | 'storm' {
  return (
    value === 'clear' ||
    value === 'cloud' ||
    value === 'rain' ||
    value === 'snow' ||
    value === 'storm'
  );
}
