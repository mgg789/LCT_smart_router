/**
 * Keys of the small service state that has to survive a restart.
 *
 * `INITIALIZED` exists because an empty `requests` table is not proof that the system was
 * never set up: after a deliberate full reset the working set is empty on purpose and a
 * restart must not quietly reload the demo data (context/37 section 9.5).
 */
export const APP_STATE_KEYS = {
  /** Whether the first-run initialisation has ever been performed. */
  INITIALIZED: 'initialized',
  /** Which start-up profile that initialisation chose: `demo` or `empty`. */
  STARTUP_PROFILE: 'startup_profile',
  /**
   * Working-set generation, raised by a reset. A late write carrying an older generation
   * belongs to the previous run and must not touch the new one
   * (context/37 section 9.6).
   */
  GENERATION: 'generation',
  /**
   * Dispatcher-owned operational controls: day bounds, alert timers and map keys.
   * Secrets in the value are never written to logs or returned in full.
   */
  DISPATCHER_SETTINGS: 'dispatcher.settings',
} as const;

export type AppStateKey = (typeof APP_STATE_KEYS)[keyof typeof APP_STATE_KEYS];
