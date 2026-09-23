const RESOLUTION_GRACE_SECONDS = 180;

/** Dispatcher decisions accepted by the alert resolution endpoint. */
export type AlertAction =
  | 'reschedule'
  | 'move_window'
  | 'add_engineer'
  | 'keep_manual'
  | 'keep_as_is'
  | 'restore_auto'
  | 'skip_lunch'
  | 'keep_lunch'
  | 'message'
  | 'remove_shift'
  | 'message_remove'
  | 'extend';

/** Returns the finite dispatcher action catalogue for one alert code. */
export function alertActionsFor(code: string): AlertAction[] {
  switch (code) {
    case 'time_risk':
    // An engineer's own forecast said the visit cannot finish inside the customer window,
    // so LIVE released the reservation and the work is back in the free pool. That is the
    // same decision as `time_risk` -- renegotiate the window, move the day, or bring in
    // someone who can still make it. It is listed here because the code is raised directly
    // by LIVE rather than through `refresh`, so without an entry it reached the dispatcher
    // as a blocking alert with no button, and a day carrying one could never be closed.
    case 'LIVE_WINDOW_COMPLETION_RISK':
      return ['reschedule', 'move_window', 'add_engineer', 'keep_as_is'];
    case 'LIVE_TECHNICAL_BREAK_OVERRUN':
      return ['keep_as_is'];
    case 'unassigned':
      return ['reschedule', 'move_window', 'add_engineer'];
    case 'plan_degraded':
    case 'plan_review_required':
      return ['keep_manual', 'restore_auto'];
    case 'lunch_conflict':
      return ['skip_lunch', 'keep_lunch'];
    case 'engineer_overdue':
      return ['message', 'remove_shift', 'extend'];
    case 'shift_no_show':
      return ['message_remove', 'remove_shift', 'extend'];
    default:
      return [];
  }
}

/** Measures only dispatcher decision time after the initial three-minute grace period. */
export function resolutionDelay(elapsedSeconds: number): number | null {
  return elapsedSeconds > RESOLUTION_GRACE_SECONDS
    ? elapsedSeconds - RESOLUTION_GRACE_SECONDS
    : null;
}
