import { z } from 'zod';

/**
 * Environment contract of the System Layer.
 *
 * Every key the process reads is declared here and validated once at bootstrap: an
 * unparsable environment must stop the process, not surface later as an undefined at
 * the first request. Keys are added by the branch that starts using them, so this schema
 * always describes exactly what the current code needs.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** TCP port of the HTTP server. */
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),

  /** Lowest level that reaches stdout. */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * IANA zone used only to render stored Unix seconds for humans. It is never added to
   * or subtracted from a stored timestamp (context/43 section 5.3).
   */
  APP_TIME_ZONE: z.string().min(1).default('Europe/Moscow'),

  /** PostgreSQL connection of the business writer. */
  DATABASE_URL: z.string().min(1),

  /** Private Router Core origin. When absent, automatic routing stays disabled. */
  ROUTER_BASE_URL: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'ROUTER_BASE_URL must use http or https',
    })
    .optional(),

  /** How often sys asks Router for a newly published result. */
  ROUTER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),

  /** Per-request timeout for the private Router HTTP API. */
  ROUTER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

  /**
   * Connection used by `prisma migrate deploy`. A deployment points it at the migration
   * owner; on a developer machine it is absent and the CLI falls back to DATABASE_URL.
   */
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),

  // --- auth-engine ---------------------------------------------------------
  // There is exactly one dispatcher. Email and password come from the server
  // configuration, and the password path deliberately does not depend on SMTP: access to
  // the Dashboard must survive a broken mail contour (context/36 section 7.1).
  DISPATCHER_EMAIL: z.email(),
  DISPATCHER_PASSWORD: z.string().min(8),

  /**
   * Lifetimes, in seconds. The concept leaves these to the auth-engine and names no
   * numbers, so these are implementation defaults, not agreed norms
   * (context/36 section 11).
   */
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(86_400),
  LOGIN_CODE_TTL_SEC: z.coerce.number().int().positive().default(600),
  LOGIN_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * Development escape hatch: returns the login code in the API response because there is
   * no SMTP-gateway in this build to deliver it. Refused in production by
   * `validateEnv` -- an exposed code is a full authentication bypass.
   */
  // --- dataset -------------------------------------------------------------
  /** Directory holding the organisers' CSV files. */
  DATASET_ROOT: z.string().min(1).default('data/dataset/anonymized'),

  /**
   * Offset of the local times printed in those files, in seconds.
   *
   * Stated explicitly rather than taken from the host: the files say `17.08.2026
   * 20:00` with no zone, and reading them on a machine in another zone would
   * silently move every window (context/33 section 4).
   */
  DATASET_TIME_ZONE_OFFSET_SEC: z.coerce
    .number()
    .int()
    .default(3 * 3600),

  AUTH_DEV_EXPOSE_CODES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env`. Throws with every offending key listed, because a partial
 * report would hide the second mistake behind the first.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AUTH_DEV_EXPOSE_CODES) {
    throw new Error(
      'Invalid environment configuration: AUTH_DEV_EXPOSE_CODES must not be enabled in ' +
        'production. Returning login codes over the API bypasses authentication entirely.',
    );
  }
  return parsed.data;
}
