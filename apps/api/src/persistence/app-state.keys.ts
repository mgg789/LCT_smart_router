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
   * The single dispatcher's current AI assist lane (`help` or `fix`, schema.prisma's own
   * comment on `AiAssistMode`), read fresh by `RoleProfileService.forActor` at every
   * confirm so a lane flip made after an operation was prepared is never missed
   * (context/35 section 8). Global, not per-account, because this deployment has exactly
   * one dispatcher (auth/actor.ts's comment on `ApiTokenCategory`).
   */
  AI_DISPATCHER_ASSIST_MODE: 'ai_dispatcher_assist_mode',
  /**
   * Dispatcher-owned operational controls: day bounds, alert timers and map keys.
   * Secrets in the value are never written to logs or returned in full.
   */
  DISPATCHER_SETTINGS: 'dispatcher.settings',
} as const;

export type AppStateKey = (typeof APP_STATE_KEYS)[keyof typeof APP_STATE_KEYS];
