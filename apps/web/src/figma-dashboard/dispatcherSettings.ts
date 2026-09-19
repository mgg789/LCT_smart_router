export const DISPATCHER_SETTINGS_KEY = 'lct.dispatcher.settings';

export type MapProvider = '2gis' | 'yandex';

export type DispatcherSettings = {
  shiftStart: string;
  shiftEnd: string;
  latenessMin: number;
  mapProvider: MapProvider;
  mapToken: string;
};

export const DEFAULT_DISPATCHER_SETTINGS: DispatcherSettings = {
  shiftStart: '09:00',
  shiftEnd: '18:00',
  latenessMin: 0,
  mapProvider: '2gis',
  mapToken: '',
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Clamps a minute count to the 0–15 dispatcher lateness field. */
export function clampLatenessMin(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(15, Math.max(0, Math.round(value)));
}

/** Turns Router window-lateness seconds into the 0–15 minute field. */
export function latenessMinFromSec(sec: number): number {
  return clampLatenessMin(sec / 60);
}

/** True when both clocks are `HH:MM` and the end is later than the start. */
export function isValidShiftWindow(start: string, end: string): boolean {
  return CLOCK.test(start) && CLOCK.test(end) && end > start;
}

/**
 * Validates the settings form. Returns a Russian error or `null` when the draft is ready.
 */
export function validateDispatcherSettings(draft: DispatcherSettings): string | null {
  if (!isValidShiftWindow(draft.shiftStart, draft.shiftEnd)) {
    return 'Укажите начало и конец дня в формате ЧЧ:ММ, конец позже начала.';
  }
  if (!Number.isInteger(draft.latenessMin) || draft.latenessMin < 0 || draft.latenessMin > 15) {
    return 'Допустимое опоздание — целое число от 0 до 15 минут.';
  }
  if (draft.mapProvider !== '2gis' && draft.mapProvider !== 'yandex') {
    return 'Выберите 2ГИС или Яндекс.';
  }
  return null;
}

/** Reads dispatcher settings from storage; broken JSON falls back to defaults. */
export function readDispatcherSettings(storage: Pick<Storage, 'getItem'>): DispatcherSettings {
  const raw = storage.getItem(DISPATCHER_SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_DISPATCHER_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<DispatcherSettings>;
    const next: DispatcherSettings = {
      shiftStart: typeof parsed.shiftStart === 'string' ? parsed.shiftStart : DEFAULT_DISPATCHER_SETTINGS.shiftStart,
      shiftEnd: typeof parsed.shiftEnd === 'string' ? parsed.shiftEnd : DEFAULT_DISPATCHER_SETTINGS.shiftEnd,
      latenessMin: clampLatenessMin(
        typeof parsed.latenessMin === 'number' ? parsed.latenessMin : DEFAULT_DISPATCHER_SETTINGS.latenessMin,
      ),
      mapProvider: parsed.mapProvider === 'yandex' ? 'yandex' : '2gis',
      mapToken: typeof parsed.mapToken === 'string' ? parsed.mapToken : '',
    };
    return validateDispatcherSettings(next) ? { ...DEFAULT_DISPATCHER_SETTINGS, mapToken: next.mapToken } : next;
  } catch {
    return { ...DEFAULT_DISPATCHER_SETTINGS };
  }
}

/** Persists dispatcher settings. The map token stays on this machine only. */
export function writeDispatcherSettings(
  storage: Pick<Storage, 'setItem'>,
  settings: DispatcherSettings,
): void {
  storage.setItem(DISPATCHER_SETTINGS_KEY, JSON.stringify(settings));
}
