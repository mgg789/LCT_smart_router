import { z } from 'zod';
import type { AlertAction } from '../../orchestrator/alerts/alert-policy';
import { localDateSchema, localTimeSchema } from '../tools/local-time';

/**
 * The alert resolver's output schema, built **per alert** so an illegal value cannot even
 * parse (AGENTS.md §9.5, D-11): `action` is narrowed to exactly `alertActionsFor(alert.code)`
 * and `engineerId` to exactly the server-computed `add_engineer` candidate list. A model
 * proposing an action this alert does not offer, or an engineer nobody vetted, fails
 * validation before any precondition check even runs -- the model never gets a chance to
 * argue its way past the catalogue.
 */

export interface RejectedOption {
  readonly action: AlertAction;
  readonly why: string;
}

export interface AlertResolverProposal {
  readonly action: AlertAction;
  readonly minutes?: number;
  readonly windowDate?: string;
  readonly windowStartLocal?: string;
  readonly windowEndLocal?: string;
  readonly engineerId?: string;
  readonly reason: string;
  readonly confidence: number;
  readonly rejected: readonly RejectedOption[];
}

export interface AlertResolverSchemaOptions {
  /** The finite catalogue for this exact alert code (`alertActionsFor`). */
  readonly allowedActions: readonly AlertAction[];
  /** Server-vetted `add_engineer` candidates; empty when the alert has none, or does not
   *  offer `add_engineer` at all. */
  readonly candidateEngineerIds: readonly string[];
}

/** Builds the per-alert Zod schema. Never called with an empty `allowedActions` -- a code
 *  with no offered action never reaches the model (the caller refuses first). */
export function buildAlertResolverSchema(options: AlertResolverSchemaOptions) {
  const actionEnum = z.enum(options.allowedActions as [AlertAction, ...AlertAction[]]);
  // Enum-narrowed whenever a candidate list exists, so an engineer nobody vetted cannot
  // even parse. With no candidates the field still parses as a plain string (an empty
  // Zod enum is not constructible), but the service's precondition layer refuses any
  // value against the same (empty) list before a proposal is ever prepared.
  const engineerIdSchema =
    options.candidateEngineerIds.length > 0
      ? z.enum(options.candidateEngineerIds as [string, ...string[]]).optional()
      : z.string().min(1).optional();

  return z
    .object({
      action: actionEnum,
      minutes: z.number().int().min(1).max(240).optional(),
      windowDate: localDateSchema.optional(),
      windowStartLocal: localTimeSchema.optional(),
      windowEndLocal: localTimeSchema.optional(),
      engineerId: engineerIdSchema,
      reason: z.string().trim().min(10).max(500),
      confidence: z.number().min(0).max(1),
      rejected: z
        .array(
          z.object({
            action: actionEnum,
            why: z.string().trim().min(1).max(500),
          }),
        )
        .max(3)
        .default([]),
    })
    .strict();
}

export type AlertResolverSchema = ReturnType<typeof buildAlertResolverSchema>;
