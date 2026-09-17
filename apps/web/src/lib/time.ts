/** Europe/Moscow offset used only at the UI edge (context/33 §4). */
export const MOSCOW_OFFSET_SEC = 3 * 3600;

const MONTHS_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
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

export function formatDurationMin(sec: number): string {
  return `${Math.round(sec / 60)} мин`;
}

export function formatKm(km: number): string {
  return `${km.toFixed(km >= 10 ? 0 : 1).replace('.', ',')} км`;
}
