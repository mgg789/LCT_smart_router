/**
 * Per-service health, reported separately on purpose.
 *
 * An unreachable SMTP or LLM must not make the application look down: the dispatcher's
 * password login has to keep working exactly when the mail contour is broken
 * (context/43 section 11.3).
 */
export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

export interface ServiceHealth {
  readonly status: ServiceStatus;
  /** Short human-readable note; never contains secrets or connection strings. */
  readonly detail?: string;
}

export interface HealthProbe {
  /** True when the application cannot serve requests without this dependency. */
  readonly required: boolean;
  check(): Promise<ServiceHealth> | ServiceHealth;
}
