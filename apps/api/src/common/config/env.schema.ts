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

  /**
   * Connection used by `prisma migrate deploy`. A deployment points it at the migration
   * owner; on a developer machine it is absent and the CLI falls back to DATABASE_URL.
   */
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
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
  return parsed.data;
}
