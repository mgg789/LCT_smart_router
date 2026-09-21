import { z } from 'zod';

const MINUTES_IN_DAY = 24 * 60;

const minuteOfDay = z.number().int().min(0).max(MINUTES_IN_DAY);
const seconds = z.number().int().min(0).max(86_400);
const secret = z.string().max(200).nullable().optional();

/** Defaults match the previous hardcoded alert timers and a typical field shift. */
export const DEFAULT_DISPATCHER_SETTINGS = {
  dayStartMin: 9 * 60,
  dayEndMin: 21 * 60,
  noShowSec: 30 * 60,
  overdueSec: 5 * 60,
  timeRiskSec: 5 * 60,
  repeatAfterSec: 15 * 60,
  twogisApiKey: null as string | null,
  yandexApiKey: null as string | null,
} as const;

export type DispatcherSettings = {
  readonly dayStartMin: number;
  readonly dayEndMin: number;
  readonly noShowSec: number;
  readonly overdueSec: number;
  readonly timeRiskSec: number;
  readonly repeatAfterSec: number;
  readonly twogisApiKey: string | null;
  readonly yandexApiKey: string | null;
};

export const dispatcherSettingsPatchSchema = z
  .object({
    dayStartMin: minuteOfDay.optional(),
    dayEndMin: minuteOfDay.optional(),
    noShowSec: seconds.optional(),
    overdueSec: seconds.optional(),
    timeRiskSec: seconds.optional(),
    repeatAfterSec: seconds.optional(),
    twogisApiKey: secret,
    yandexApiKey: secret,
  })
  .refine(
    (value) =>
      value.dayStartMin === undefined ||
      value.dayEndMin === undefined ||
      value.dayEndMin > value.dayStartMin,
    { message: 'The working day must end after it starts' },
  );

export type DispatcherSettingsPatch = z.infer<typeof dispatcherSettingsPatchSchema>;

export interface DispatcherSettingsView {
  readonly dayStartMin: number;
  readonly dayEndMin: number;
  readonly noShowSec: number;
  readonly overdueSec: number;
  readonly timeRiskSec: number;
  readonly repeatAfterSec: number;
  readonly twogisApiKeySet: boolean;
  readonly twogisApiKeyLast4: string | null;
  readonly yandexApiKeySet: boolean;
  readonly yandexApiKeyLast4: string | null;
}

const storedSchema = z.object({
  dayStartMin: minuteOfDay.default(DEFAULT_DISPATCHER_SETTINGS.dayStartMin),
  dayEndMin: minuteOfDay.default(DEFAULT_DISPATCHER_SETTINGS.dayEndMin),
  noShowSec: seconds.default(DEFAULT_DISPATCHER_SETTINGS.noShowSec),
  overdueSec: seconds.default(DEFAULT_DISPATCHER_SETTINGS.overdueSec),
  timeRiskSec: seconds.default(DEFAULT_DISPATCHER_SETTINGS.timeRiskSec),
  repeatAfterSec: seconds.default(DEFAULT_DISPATCHER_SETTINGS.repeatAfterSec),
  twogisApiKey: z.string().min(1).max(200).nullable().default(null),
  yandexApiKey: z.string().min(1).max(200).nullable().default(null),
});

/** Reads persisted JSON, filling any missing field with the previous hardcoded default. */
export function parseDispatcherSettings(value: unknown): DispatcherSettings {
  const parsed = storedSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return { ...DEFAULT_DISPATCHER_SETTINGS };
  }
  const next = parsed.data;
  if (next.dayEndMin <= next.dayStartMin) {
    return {
      ...DEFAULT_DISPATCHER_SETTINGS,
      ...next,
      dayEndMin: DEFAULT_DISPATCHER_SETTINGS.dayEndMin,
    };
  }
  return next;
}

/** Merges a patch. `null` on a key clears it; omitted keys stay. */
export function mergeDispatcherSettings(
  current: DispatcherSettings,
  patch: DispatcherSettingsPatch,
): DispatcherSettings {
  const next: DispatcherSettings = {
    dayStartMin: patch.dayStartMin ?? current.dayStartMin,
    dayEndMin: patch.dayEndMin ?? current.dayEndMin,
    noShowSec: patch.noShowSec ?? current.noShowSec,
    overdueSec: patch.overdueSec ?? current.overdueSec,
    timeRiskSec: patch.timeRiskSec ?? current.timeRiskSec,
    repeatAfterSec: patch.repeatAfterSec ?? current.repeatAfterSec,
    twogisApiKey:
      patch.twogisApiKey === undefined ? current.twogisApiKey : normalizeSecret(patch.twogisApiKey),
    yandexApiKey:
      patch.yandexApiKey === undefined ? current.yandexApiKey : normalizeSecret(patch.yandexApiKey),
  };
  if (next.dayEndMin <= next.dayStartMin) {
    throw new Error('The working day must end after it starts');
  }
  return next;
}

/** Public view: presence and last four characters only, never the secret. */
export function toDispatcherSettingsView(settings: DispatcherSettings): DispatcherSettingsView {
  return {
    dayStartMin: settings.dayStartMin,
    dayEndMin: settings.dayEndMin,
    noShowSec: settings.noShowSec,
    overdueSec: settings.overdueSec,
    timeRiskSec: settings.timeRiskSec,
    repeatAfterSec: settings.repeatAfterSec,
    twogisApiKeySet: settings.twogisApiKey !== null,
    twogisApiKeyLast4: last4(settings.twogisApiKey),
    yandexApiKeySet: settings.yandexApiKey !== null,
    yandexApiKeyLast4: last4(settings.yandexApiKey),
  };
}

/** Unix seconds for a Moscow civil clock given as minutes from midnight. */
export function moscowMinutesToUnix(workDate: string, minutes: number): number {
  const [yearText, monthText, dayText] = workDate.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid work date: ${workDate}`);
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return Date.UTC(year, month - 1, day, hours - 3, mins, 0) / 1000;
}

function normalizeSecret(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

function last4(value: string | null): string | null {
  if (value === null || value.length < 4) {
    return value === null ? null : value;
  }
  return value.slice(-4);
}
