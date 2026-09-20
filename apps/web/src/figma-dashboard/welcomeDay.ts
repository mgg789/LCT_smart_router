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

/**
 * Whether MAIN should unmount the dashboard for the start-of-day splash.
 *
 * A running (or finished) LIVE day never goes back to Welcome just because a
 * refresh fell into the cached source or the local "started" flag is stale.
 * Demo still uses `welcomeOpen`. A pending LIVE card always asks to start.
 */
export function shouldShowStartWelcome(input: {
  readonly source: 'live' | 'cached' | 'demo';
  readonly liveStatus: 'pending' | 'running' | 'finished' | null;
  readonly welcomeOpen: boolean;
  readonly hasSnapshot: boolean;
}): boolean {
  if (input.liveStatus === 'pending') return true;
  if (input.liveStatus === 'running' || input.liveStatus === 'finished') return false;
  if (input.source === 'demo') return input.welcomeOpen;
  if (input.source === 'cached') return input.welcomeOpen && !input.hasSnapshot;
  return false;
}
