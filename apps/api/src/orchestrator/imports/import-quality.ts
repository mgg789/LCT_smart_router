import type { ImportQualityFinding } from '@lct/shared';

export type { ImportQualityFinding } from '@lct/shared';

/** A request after structural parsing and coordinate resolution, before database writes. */
export interface ImportQualityRequest {
  readonly externalId: string;
  readonly addressText: string;
  readonly lat: number;
  readonly lon: number;
  readonly serviceDurationSec: number;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly district?: string | null;
  readonly allDayWindow?: boolean;
}

/** The optional location against which batch requests can be compared. */
export interface ImportQualityDepot {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Screen normalized requests for known oddities and robust batch outliers.
 * Findings are advisory only: this function never alters or rejects the input.
 */
export function analyzeImportQuality(
  requests: readonly ImportQualityRequest[],
  depot?: ImportQualityDepot,
): ImportQualityFinding[] {
  const findings: ImportQualityFinding[] = [];
  const add = (
    code: string,
    layer: ImportQualityFinding['layer'],
    ids: readonly string[],
    message: string,
    score?: number,
  ) => {
    if (ids.length === 0) return;
    findings.push({
      code,
      layer,
      count: ids.length,
      examples: ids.slice(0, 3),
      message,
      ...(score === undefined ? {} : { score }),
    });
  };

  add(
    'all_day_windows',
    'rules',
    requests
      .filter((request) => request.allDayWindow || isWholeDay(request))
      .map((item) => item.externalId),
    'У некоторых заявок окно охватывает почти весь день; это может быть особенностью данных.',
  );
  add(
    'missing_district',
    'rules',
    requests
      .filter((request) => request.district !== undefined && !request.district?.trim())
      .map((item) => item.externalId),
    'У некоторых заявок не указан район; адрес и координаты сохранены.',
  );
  add(
    'unusual_address_prefix',
    'rules',
    requests
      .filter((request) =>
        /^(?:г\.?\s*город|город\s+город|москва\s*,)/iu.test(request.addressText.trim()),
      )
      .map((item) => item.externalId),
    'В некоторых адресах необычно указан город; при необходимости проверьте эти строки.',
  );

  const addressGroups = new Map<string, string[]>();
  for (const request of requests) {
    const key = request.addressText.trim().toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ');
    const group = addressGroups.get(key) ?? [];
    group.push(request.externalId);
    addressGroups.set(key, group);
  }
  add(
    'duplicate_addresses',
    'statistics',
    [...addressGroups.values()].filter((group) => group.length > 1).flat(),
    'Несколько заявок имеют один адрес; возможно, это разные работы в одной точке.',
  );

  addOutliers(findings, 'window_length_outliers', 'длина окна', requests, (request) =>
    Math.max(1, request.windowEndAt - request.windowStartAt),
  );
  addOutliers(findings, 'service_duration_outliers', 'длительность работы', requests, (request) =>
    Math.max(1, request.serviceDurationSec),
  );
  if (depot) {
    addOutliers(findings, 'distance_outliers', 'удалённость от депо', requests, (request) =>
      Math.max(1, distanceMeters(depot, request)),
    );
  }

  return findings.sort((left, right) => left.code.localeCompare(right.code));
}

function addOutliers(
  findings: ImportQualityFinding[],
  code: string,
  featureLabel: string,
  requests: readonly ImportQualityRequest[],
  feature: (request: ImportQualityRequest) => number,
): void {
  if (requests.length < 4) return;
  const values = requests.map((request) => Math.log(feature(request)));
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = median(deviations);
  const outliers = requests
    .map((request, index) => {
      const deviation = deviations[index] ?? 0;
      return {
        id: request.externalId,
        score:
          mad === 0
            ? deviation === 0
              ? 0
              : Number.POSITIVE_INFINITY
            : (0.67448975 * deviation) / mad,
      };
    })
    .filter((item) => item.score > 3.5)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (outliers.length === 0) return;
  const score = outliers[0]?.score;
  findings.push({
    code,
    layer: 'statistics',
    count: outliers.length,
    examples: outliers.slice(0, 3).map((item) => item.id),
    message: `У некоторых заявок необычная ${featureLabel} по сравнению с остальной пачкой.`,
    ...(score === undefined || !Number.isFinite(score) ? {} : { score: Number(score.toFixed(2)) }),
  });
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[middle - 1];
  const upper = ordered[middle];
  return ordered.length % 2 === 0 ? ((lower ?? 0) + (upper ?? 0)) / 2 : (upper ?? 0);
}

function isWholeDay(request: ImportQualityRequest): boolean {
  const duration = request.windowEndAt - request.windowStartAt;
  return duration >= 23 * 60 * 60 && duration <= 24 * 60 * 60;
}

function distanceMeters(from: ImportQualityDepot, to: ImportQualityRequest): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lon - from.lon);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
