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
   * Optional duration of an entire logical workday in wall-clock seconds. Empty means
   * ordinary 1:1 time. LIVE persists the chosen value when the dispatcher starts a day,
   * so changing the environment cannot warp a day already in progress.
   */
  speed_up_work_stub: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .pipe(z.number().int().min(60).max(86_400).nullable())
    .default(null),

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
  /**
   * Engineer App sessions live on the device for a working month. Dispatcher
   * sessions stay on `SESSION_TTL_SEC` so a shared Dashboard console does not
   * remain signed in for 30 days.
   */
  ENGINEER_SESSION_TTL_SEC: z.coerce.number().int().positive().default(2_592_000),
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

  /**
   * External SMTP submission. Absent host means the gateway stays `not_configured`
   * and login codes are not sent. When the host is set, user and password are required.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(2525),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).default('Navix <noreply@mail.droidje.com>'),
  SMTP_FALLBACK_HOST: z.string().min(1).optional(),
  SMTP_FALLBACK_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_HEALTH_URL: z.url().optional(),
  SMTP_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  SMTP_APP_BASE_URL: z.url().default('https://navix.droidje.com'),

  // --- AI-gateway ------------------------------------------------------------
  // `off` keeps the chat surface honestly disabled. `replay` reads recorded fixtures and
  // needs no network at all, which is what makes the offline demo contour possible
  // (AGENTS.md section 4.7). `agents` and `openai_chat` both talk to a real,
  // OpenAI-compatible endpoint through different client surfaces (see
  // src/ai/provider/llm-provider.port.ts for why two implementations exist).
  LLM_PROVIDER: z.enum(['off', 'agents', 'openai_chat', 'replay']).default('off'),
  /** Bearer credential for the configured endpoint. Absent unless a live provider is used. */
  LLM_TOKEN: z.string().min(1).optional(),
  /** OpenAI-compatible origin. DeepSeek by default; any compatible endpoint works. */
  LLM_BASE_URL: z.url().default('https://api.deepseek.com'),
  LLM_MODEL: z.string().min(1).default('deepseek-flash'),
  /** Secondary provider tried once the primary's retry budget is spent. */
  LLM_FALLBACK_PROVIDER: z.enum(['none', 'openai_chat', 'replay']).default('none'),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  /**
   * Per-run attempt budget, shared by primary retries and the one fallback hop -- see
   * src/ai/provider/retry.policy.ts, the single owner of what this number means.
   */
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Bound on the tool-call / tool-result round trips inside one assistant turn. */
  LLM_MAX_TOOL_STEPS: z.coerce.number().int().min(1).max(12).default(6),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(1_024),
  /** How many recent conversation messages are sent to the model as context. */
  AI_HISTORY_MESSAGES: z.coerce.number().int().min(4).max(100).default(24),
  /** Keep-alive interval for an open run's SSE connection. */
  AI_SSE_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  AI_DAILY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(30),
  AI_DAILY_COST_LIMIT_MICROS: z.coerce.number().int().positive().default(200_000),
  AI_TOTAL_COST_LIMIT_MICROS: z.coerce.number().int().positive().default(4_000_000),
  /** Pricing used to turn provider usage into micros of the account's cost budget. */
  AI_UNITS_PER_1K_PROMPT_MICROS: z.coerce.number().int().nonnegative().default(2_000),
  AI_UNITS_PER_1K_COMPLETION_MICROS: z.coerce.number().int().nonnegative().default(8_000),
  /** Reserved before a run's real usage is known; refunded down to the settled amount. */
  AI_RUN_ESTIMATE_MICROS: z.coerce.number().int().positive().default(20_000),
  AI_REPLAY_DIR: z.string().min(1).default('apps/api/test/fixtures/ai'),
  /** Forces one fixture regardless of the last user message; unset lets replay pick by hash. */
  AI_REPLAY_SCENARIO: z.string().min(1).optional(),
  /**
   * Logs full prompts and raw provider responses. Left on only for local debugging: a
   * transcript can contain a customer's problem description and address.
   */
  AI_DEBUG_PROMPTS: z
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
  if (parsed.data.SMTP_HOST && (!parsed.data.SMTP_USER || !parsed.data.SMTP_PASSWORD)) {
    throw new Error(
      'Invalid environment configuration: SMTP_HOST is set but SMTP_USER or SMTP_PASSWORD ' +
        'is missing. Leave SMTP_HOST unset to keep mail unconfigured.',
    );
  }
  if (
    (parsed.data.LLM_PROVIDER === 'agents' || parsed.data.LLM_PROVIDER === 'openai_chat') &&
    !parsed.data.LLM_TOKEN
  ) {
    throw new Error(
      'Invalid environment configuration: LLM_PROVIDER requires LLM_TOKEN for a live ' +
        'provider. Set LLM_PROVIDER=replay or LLM_PROVIDER=off to run without a key.',
    );
  }
  if (parsed.data.LLM_FALLBACK_PROVIDER === 'openai_chat' && !parsed.data.LLM_TOKEN) {
    throw new Error(
      'Invalid environment configuration: LLM_FALLBACK_PROVIDER=openai_chat requires ' +
        'LLM_TOKEN, the same credential the fallback client reuses.',
    );
  }
  if (parsed.data.LLM_FALLBACK_PROVIDER !== 'none' && parsed.data.LLM_MAX_ATTEMPTS < 2) {
    throw new Error(
      'Invalid environment configuration: a configured LLM_FALLBACK_PROVIDER needs ' +
        'LLM_MAX_ATTEMPTS >= 2 -- the fallback hop is spent out of that same budget ' +
        '(src/ai/provider/retry.policy.ts) and needs at least one attempt of its own.',
    );
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AI_DEBUG_PROMPTS) {
    throw new Error(
      'Invalid environment configuration: AI_DEBUG_PROMPTS must not be enabled in ' +
        "production. It logs full prompts, which can contain a customer's problem " +
        'description and address.',
    );
  }
  return parsed.data;
}
