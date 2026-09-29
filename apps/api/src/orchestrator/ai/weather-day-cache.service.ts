import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { configuredTimeZone } from '../../common/time/zone';
import { APP_STATE_KEYS, lockWorkingSetGeneration, PrismaService } from '../../persistence';

const ARCHIVE_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
const FETCH_TIMEOUT_MS = 2500;

/** Stable location key prevents a region rename/reuse from serving stale coordinates. */
export function weatherLocationHash(latitude: number, longitude: number): string {
  return createHash('sha256')
    .update(`${latitude.toFixed(5)},${longitude.toFixed(5)}`)
    .digest('hex');
}

function weatherKind(code: number): 'clear' | 'cloud' | 'rain' | 'snow' | 'storm' | null {
  if (code === 0) return 'clear';
  if ([1, 2, 3, 45, 48].includes(code)) return 'cloud';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([56, 57, 66, 67, 71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return 'rain';
  return null;
}

interface ArchivePayload {
  readonly daily?: { readonly time?: unknown; readonly weather_code?: unknown };
}

/**
 * Backfills one persistent region/date weather cache from the fixed Open-Meteo archive.
 * Failed fetches leave observations unavailable and do not block the offline contour.
 */
@Injectable()
export class WeatherDayCacheService {
  private readonly logger = new Logger(WeatherDayCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  async fillMissing(
    region: string,
    latitude: number,
    longitude: number,
    workDates: readonly string[],
  ): Promise<void> {
    const dates = [...new Set(workDates)].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    if (!dates.length) return;
    const locationHash = weatherLocationHash(latitude, longitude);
    const cached = await this.prisma.weatherDayCache.findMany({
      where: { region, workDate: { in: dates }, locationHash },
      select: { workDate: true },
    });
    const known = new Set(cached.map((row) => row.workDate));
    const missing = dates.filter((date) => !known.has(date));
    if (!missing.length) return;
    const generationState = await this.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.GENERATION },
      select: { value: true },
    });
    const generation = String(generationState?.value ?? 1);

    const query = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      start_date: missing[0] ?? '',
      end_date: missing.at(-1) ?? '',
      daily: 'weather_code',
      timezone: configuredTimeZone(),
    });
    const url = new URL(`${ARCHIVE_ENDPOINT}?${query.toString()}`);
    if (url.protocol !== 'https:' || url.hostname !== 'archive-api.open-meteo.com') return;
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as ArchivePayload;
      const times = payload.daily?.time;
      const codes = payload.daily?.weather_code;
      if (!Array.isArray(times) || !Array.isArray(codes) || times.length !== codes.length) return;
      const rows: Array<{
        date: string;
        code: number;
        kind: NonNullable<ReturnType<typeof weatherKind>>;
      }> = [];
      for (let index = 0; index < times.length; index += 1) {
        const date = times[index];
        const code = codes[index];
        if (typeof date !== 'string' || !Number.isInteger(code) || !missing.includes(date))
          continue;
        const kind = weatherKind(code);
        if (!kind) continue;
        rows.push({ date, code, kind });
      }
      if (!rows.length) return;
      await this.prisma.$transaction(async (tx) => {
        await lockWorkingSetGeneration(tx);
        const current = await tx.appState.findUnique({
          where: { key: APP_STATE_KEYS.GENERATION },
          select: { value: true },
        });
        if (String(current?.value ?? 1) !== generation) return;
        const fetchedAt = BigInt(Math.floor(Date.now() / 1000));
        for (const row of rows) {
          await tx.weatherDayCache.upsert({
            where: { region_workDate: { region, workDate: row.date } },
            create: {
              region,
              workDate: row.date,
              locationHash,
              weatherCode: row.code,
              kind: row.kind,
              fetchedAt,
            },
            update: { locationHash, weatherCode: row.code, kind: row.kind, fetchedAt },
          });
        }
      });
    } catch (error) {
      this.logger.debug(`Weather archive unavailable for region ${region}: ${String(error)}`);
    }
  }
}
