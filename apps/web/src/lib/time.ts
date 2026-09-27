import { t } from '../i18n';
/** Europe/Moscow offset used only at the UI edge (context/33 §4). */
export const MOSCOW_OFFSET_SEC = 3 * 3600;

const MONTHS_RU = [
  t('lib.time.05ae68ac92'),
  t('lib.time.3ae2c0e9eb'),
  t('lib.time.6cfa0bb4f6'),
  t('lib.time.3144ee44fc'),
  t('lib.time.2869fa115c'),
  t('lib.time.b4c08e7bda'),
  t('lib.time.a18a66ad65'),
  t('lib.time.4ae69d9dc7'),
  t('lib.time.67cb393e75'),
  t('lib.time.fd08856334'),
  t('lib.time.01bd452597'),
  t('lib.time.866b5e92d8'),
] as const;

/** Unix seconds for a civil clock time on a Moscow calendar day `YYYY-MM-DD`. */
export function moscowAt(workDate: string, hour: number, minute = 0, second = 0): number {
  const [yearText, monthText, dayText] = workDate.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid work date: ${workDate}`);
  }
  return Date.UTC(year, month - 1, day, hour - 3, minute, second) / 1000;
}

export function formatClock(unixSec: number): string {
  const local = new Date((unixSec + MOSCOW_OFFSET_SEC) * 1000);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatDayTitle(workDate: string): string {
  const [yearText, monthText, dayText] = workDate.split('-');
  const monthIndex = Number(monthText) - 1;
  const month = MONTHS_RU[monthIndex];
  if (!yearText || !dayText || month === undefined) {
    return workDate;
  }
  return `${Number(dayText)} ${month} ${yearText}`;
}

/** Moscow calendar date `D month YYYY` for a Unix-seconds moment. */
export function formatMoscowDate(unixSec: number): string {
  const local = new Date((unixSec + MOSCOW_OFFSET_SEC) * 1000);
  const month = MONTHS_RU[local.getUTCMonth()];
  if (month === undefined) {
    return String(unixSec);
  }
  return `${local.getUTCDate()} ${month} ${local.getUTCFullYear()}`;
}

export function formatDurationMin(sec: number): string {
  return t('lib.time.d662a84f53', { value0: Math.round(sec / 60) });
}

export function formatKm(km: number): string {
  return t('lib.time.06f7f314d2', { value0: km.toFixed(km >= 10 ? 0 : 1).replace('.', ',') });
}
