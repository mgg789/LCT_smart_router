import { createHash } from 'node:crypto';
import type { WeatherMultiplierCalibration } from '../../routing/router-gateway';

export type CalibrationWeatherKind = 'clear' | 'cloud' | 'rain' | 'snow' | 'storm';
export type CalibrationTransport = 'car' | 'walk' | 'bike' | 'transit';

export interface WeatherLegObservation {
  readonly region: string;
  readonly transport: CalibrationTransport;
  readonly kind: CalibrationWeatherKind;
  readonly workDate: string;
  readonly actualSec: number;
  readonly canonicalSec: number;
}

/** Paired factory/candidate probabilities saved before each held-out request finishes. */
export interface WeatherRiskValidation {
  readonly region: string;
  readonly transport: CalibrationTransport;
  readonly kind: CalibrationWeatherKind;
  readonly workDate: string;
  readonly baselineProbability: number;
  readonly candidateProbability: number;
  readonly actualBreach: boolean;
  readonly candidateVersion: string;
}

export interface WeatherCalibrationCoverage {
  readonly status: 'factory' | 'collecting' | 'shadow' | 'validated';
  readonly observationCount: number;
  readonly days: number;
  readonly eligibleGroups: number;
  readonly totalGroups: number;
  readonly version: string | null;
  readonly source: 'travel_elapsed_proxy';
  readonly uncertainty: 'not_estimated';
  readonly reason: string;
}

export interface WeatherCalibrationCandidate {
  readonly region: string;
  readonly transport_type: CalibrationTransport;
  readonly kind: 'rain' | 'snow' | 'storm';
  readonly multiplier: number;
  readonly clearBias: number;
  readonly observations: number;
  readonly days: number;
  readonly training_cutoff: string;
  readonly candidate_version: string;
}

export interface WeatherCalibrationResult {
  readonly multipliers: WeatherMultiplierCalibration[];
  readonly coverage: WeatherCalibrationCoverage;
}

const MIN_KIND_OBSERVATIONS = 15;
const MIN_KIND_DAYS = 2;
const MIN_PAIRED_RISK_CASES = 15;
const FACTORY_MULTIPLIER: Record<'rain' | 'snow' | 'storm', number> = {
  // Match the factory prediction regimes, not the road-planning weather factors.
  rain: 1.12,
  snow: 1.25,
  storm: 1.25,
};

/** Fits a frozen candidate from only the dates up to its recorded training cutoff. */
export function fitWeatherCandidates(
  input: readonly WeatherLegObservation[],
): WeatherCalibrationCandidate[] {
  const groups = new Map<string, WeatherLegObservation[]>();
  for (const row of input) {
    if (!validObservation(row)) continue;
    const key = `${row.region}\u0000${row.transport}`;
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  const candidates: WeatherCalibrationCandidate[] = [];
  for (const rows of groups.values()) {
    const reference = rows.filter((row) => row.kind === 'clear' || row.kind === 'cloud');
    if (reference.length < MIN_KIND_OBSERVATIONS || uniqueDays(reference).size < MIN_KIND_DAYS)
      continue;
    for (const kind of ['rain', 'snow', 'storm'] as const) {
      const weather = rows.filter((row) => row.kind === kind);
      if (weather.length < MIN_KIND_OBSERVATIONS || uniqueDays(weather).size < MIN_KIND_DAYS)
        continue;
      const training = [...reference, ...weather];
      const multiplier = clamp(Math.exp(meanLogRatio(weather) - meanLogRatio(reference)), 0.5, 3);
      const trainingCutoff =
        training
          .map((row) => row.workDate)
          .sort()
          .at(-1) ?? '';
      candidates.push({
        region: rows[0]?.region ?? '',
        transport_type: rows[0]?.transport ?? 'car',
        kind,
        multiplier: Number(multiplier.toFixed(4)),
        clearBias: Number(Math.exp(meanLogRatio(reference)).toFixed(4)),
        observations: training.length,
        days: uniqueDays(training).size,
        training_cutoff: trainingCutoff,
        candidate_version: versionOf(training, kind, Number(multiplier.toFixed(4))),
      });
    }
  }
  return candidates;
}

/** Promotes only the exact frozen candidate whose later, paired risk labels pass both gates. */
export function validateWeatherCandidates(
  candidates: readonly WeatherCalibrationCandidate[],
  observations: readonly WeatherLegObservation[],
  riskValidation: readonly WeatherRiskValidation[],
): WeatherMultiplierCalibration[] {
  const accepted: WeatherMultiplierCalibration[] = [];
  for (const candidate of candidates) {
    const later = observations.filter(
      (row) =>
        row.region === candidate.region &&
        row.transport === candidate.transport_type &&
        row.workDate > candidate.training_cutoff &&
        validObservation(row),
    );
    const reference = later.filter((row) => row.kind === 'clear' || row.kind === 'cloud');
    const weather = later.filter((row) => row.kind === candidate.kind);
    if (
      reference.length < MIN_KIND_OBSERVATIONS ||
      weather.length < MIN_KIND_OBSERVATIONS ||
      uniqueDays(reference).size < MIN_KIND_DAYS ||
      uniqueDays(weather).size < MIN_KIND_DAYS
    )
      continue;
    const pairedRisk = riskValidation.filter(
      (row) =>
        row.candidateVersion === candidate.candidate_version &&
        row.region === candidate.region &&
        row.transport === candidate.transport_type &&
        row.kind === candidate.kind &&
        row.workDate > candidate.training_cutoff &&
        validProbability(row.baselineProbability) &&
        validProbability(row.candidateProbability),
    );
    if (
      pairedRisk.length < MIN_PAIRED_RISK_CASES ||
      new Set(pairedRisk.map((row) => row.workDate)).size < MIN_KIND_DAYS ||
      !pairedRisk.some((row) => row.actualBreach) ||
      !pairedRisk.some((row) => !row.actualBreach)
    )
      continue;
    const clearBiasLog = Math.log(candidate.clearBias);
    const evaluationLegs = [...reference, ...weather];
    const candidateTravelError = meanAbsoluteLogError(
      evaluationLegs,
      clearBiasLog,
      candidate.multiplier,
      candidate.kind,
    );
    const baselineTravelError = meanAbsoluteLogError(
      evaluationLegs,
      clearBiasLog,
      FACTORY_MULTIPLIER[candidate.kind],
      candidate.kind,
    );
    const baselineBrier = brierRisk(pairedRisk, 'baselineProbability');
    const candidateBrier = brierRisk(pairedRisk, 'candidateProbability');
    if (candidateTravelError > baselineTravelError || candidateBrier > baselineBrier) continue;
    const evidence = [...reference, ...weather];
    accepted.push({
      region: candidate.region,
      transport_type: candidate.transport_type,
      kind: candidate.kind,
      multiplier: candidate.multiplier,
      source: 'learned',
      observations: evidence.length,
      days: uniqueDays(evidence).size,
      baseline_travel_error: roundMetric(baselineTravelError),
      candidate_travel_error: roundMetric(candidateTravelError),
      baseline_brier: roundMetric(baselineBrier),
      candidate_brier: roundMetric(candidateBrier),
      validation_version: candidate.candidate_version,
    });
  }
  return accepted;
}

/**
 * Fits weather factors per region and transport, then checks the untouched later days.
 * A candidate is returned only when both same-case travel error and lateness-risk Brier score
 * are no worse than their factory baselines. This uses elapsed travel as a proxy, never
 * the work-type normative allowance.
 */
export function calibrateWeatherRegimes(
  input: readonly WeatherLegObservation[],
  riskValidation: readonly WeatherRiskValidation[] = [],
  frozenCandidates?: readonly WeatherCalibrationCandidate[],
): WeatherCalibrationResult {
  const observations = input.filter(validObservation);
  const groups = new Map<string, WeatherLegObservation[]>();
  for (const row of observations) {
    const key = `${row.region}\u0000${row.transport}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const candidates = frozenCandidates ?? fitWeatherCandidates(observations);
  const multipliers = validateWeatherCandidates(candidates, observations, riskValidation);
  const groupDays = new Set(observations.map((row) => `${row.region}\u0000${row.workDate}`));
  const version = observations.length ? versionOf(observations, 'all', observations.length) : null;
  const status: WeatherCalibrationCoverage['status'] = multipliers.length
    ? 'validated'
    : candidates.length
      ? 'shadow'
      : observations.length
        ? 'collecting'
        : 'factory';
  return {
    multipliers,
    coverage: {
      status,
      observationCount: observations.length,
      days: groupDays.size,
      eligibleGroups: new Set(multipliers.map((row) => `${row.region}\u0000${row.transport_type}`))
        .size,
      totalGroups: groups.size,
      version,
      source: 'travel_elapsed_proxy',
      uncertainty: 'not_estimated',
      reason:
        status === 'validated'
          ? 'Проверка на следующих датах прошла для подходящих региональных и транспортных групп.'
          : candidates.length
            ? 'Собираются парные данные риска опоздания на последующих датах; кандидаты пока работают только в теневом режиме.'
            : observations.length
              ? 'Для региональных и транспортных групп пока недостаточно поездок с привязанной погодой.'
              : 'Нет сопоставленных наблюдений о погоде и поездках.',
    },
  };
}

function uniqueDays(rows: readonly WeatherLegObservation[]): Set<string> {
  return new Set(rows.map((row) => row.workDate));
}

/** Each local date contributes one mean, regardless of the number of visits recorded. */
function dayBalancedMean<T extends { readonly workDate: string }>(
  rows: readonly T[],
  value: (row: T) => number,
): number {
  const days = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const day = days.get(row.workDate) ?? { sum: 0, count: 0 };
    day.sum += value(row);
    day.count += 1;
    days.set(row.workDate, day);
  }
  return days.size
    ? [...days.values()].reduce((sum, day) => sum + day.sum / day.count, 0) / days.size
    : 0;
}

function meanLogRatio(rows: readonly WeatherLegObservation[]): number {
  return dayBalancedMean(rows, (row) => Math.log(row.actualSec / row.canonicalSec));
}

function meanAbsoluteLogError(
  rows: readonly WeatherLegObservation[],
  clearBias: number,
  weatherMultiplier: number,
  kind: 'rain' | 'snow' | 'storm',
): number {
  return dayBalancedMean(rows, (row) => {
    const isTargetWeather = row.kind === kind;
    const predicted = clearBias + (isTargetWeather ? Math.log(weatherMultiplier) : 0);
    return Math.abs(Math.log(row.actualSec / row.canonicalSec) - predicted);
  });
}

function validObservation(row: WeatherLegObservation): boolean {
  return (
    row.region.length > 0 &&
    Number.isFinite(row.actualSec) &&
    row.actualSec > 0 &&
    Number.isFinite(row.canonicalSec) &&
    row.canonicalSec > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.workDate)
  );
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function brierRisk(
  rows: readonly WeatherRiskValidation[],
  field: 'baselineProbability' | 'candidateProbability',
): number {
  return dayBalancedMean(rows, (row) => (row[field] - Number(row.actualBreach)) ** 2);
}

function versionOf(
  rows: readonly WeatherLegObservation[],
  kind: string,
  multiplier: number,
): string {
  const payload = JSON.stringify({
    kind,
    multiplier,
    rows: rows
      .map(({ region, transport, workDate, kind: weather, actualSec, canonicalSec }) => ({
        region,
        transport,
        workDate,
        weather,
        actualSec,
        canonicalSec,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}
