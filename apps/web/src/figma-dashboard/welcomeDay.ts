export const WORKDAY_STARTED_KEY = 'lct.dispatcher.workday.started';

/** Moscow civil date `YYYY-MM-DD` at the given instant. */
export function moscowWorkDate(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

/** Moscow `HH:MM` clock for the welcome chip. */
export function moscowClockLabel(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(nowMs));
}

/** True when the dispatcher already pressed «Начать рабочий день» for this Moscow date. */
export function hasStartedWorkDay(storage: Pick<Storage, 'getItem'>, date: string): boolean {
  return storage.getItem(WORKDAY_STARTED_KEY) === date;
}

/** Remembers that today's shift is open. A new Moscow date shows the welcome again. */
export function markWorkDayStarted(storage: Pick<Storage, 'setItem'>, date: string): void {
  storage.setItem(WORKDAY_STARTED_KEY, date);
}

/** Closes the dispatcher shift so Welcome is shown again. */
export function clearWorkDayStarted(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(WORKDAY_STARTED_KEY);
}
