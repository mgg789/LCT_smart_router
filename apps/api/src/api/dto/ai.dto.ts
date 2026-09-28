import { z } from 'zod';
import { operationEnvelopeSchema } from './request.dto';

const modelEndpoint = z
  .string()
  .trim()
  .max(300)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Укажите HTTP(S) URL без логина и пароля')
  .nullable()
  .optional();
const modelKey = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !value || value.length >= 8)
  .optional();

/** Plan-assessment and live model connection fields. Secrets are write-only. */
export const aiSettingsSchema = z.object({
  operationId: z.string().min(8).max(128),
  planCalibrationEnabled: z.boolean().optional(),
  llmApiUrl: modelEndpoint,
  llmModel: z.string().trim().max(120).nullable().optional(),
  llmApiKey: modelKey,
  clearLlmApiKey: z.boolean().optional(),
  jevApiUrl: modelEndpoint,
  jevModel: z.string().trim().max(120).nullable().optional(),
  jevApiKey: modelKey,
  clearJevApiKey: z.boolean().optional(),
});

export type AiSettingsDto = z.infer<typeof aiSettingsSchema>;

/**
 * Request shapes for the AI-gateway contour.
 *
 * `operationEnvelopeSchema` is reused rather than re-declared: `operationId` is what
 * lets a retried send replay instead of duplicating (context/36 section 12), the same
 * guarantee every other write in this API relies on.
 */

export const createAiConversationSchema = z.object({
  /** Which request/engineer/alert the dialogue was opened about, if any. */
  contextRef: z.record(z.string(), z.unknown()).nullish(),
  /**
   * Meaningful only when the actor is a dispatcher: chooses which of the two dispatcher
   * lanes this conversation opens. A new dispatcher dialogue always starts in `help`;
   * `fix` is an explicit request, never inferred (schema.prisma's own comment on
   * `AiAssistMode`). Ignored for a client or engineer actor.
   */
  assistMode: z.enum(['help', 'fix']).optional(),
});
export type CreateAiConversationDto = z.infer<typeof createAiConversationSchema>;

export const setAiAssistModeSchema = z.object({
  assistMode: z.enum(['help', 'fix']),
});
export type SetAiAssistModeDto = z.infer<typeof setAiAssistModeSchema>;

export const postAiMessageSchema = operationEnvelopeSchema.extend({
  text: z.string().trim().min(1).max(4000),
});
export type PostAiMessageDto = z.infer<typeof postAiMessageSchema>;

export const afterSeqQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
});
export type AfterSeqQueryDto = z.infer<typeof afterSeqQuerySchema>;

/** Body of both `POST /ai/operations/:id/apply` and `.../cancel`: the confirming human's
 *  own idempotency key for the underlying business write (ai-operation.service.ts's own
 *  note on why this is a separate id from the prepared card's own). */
export const confirmAiOperationSchema = z.object({ operationId: z.uuid() });
export type ConfirmAiOperationDto = z.infer<typeof confirmAiOperationSchema>;

/**
 * Body of `POST /ai/explain`.
 *
 * `client` is deliberately not an offered scope: an honest explanation needs the roster
 * (who else was idle, who else had the skill), which a customer must never see (task
 * brief for `src/ai/explain/**`).
 */
export const explainRequestSchema = z
  .object({
    scope: z.enum(['request', 'engineer', 'route', 'alert', 'policy', 'plan', 'degraded']),
    requestId: z.string().min(1).optional(),
    engineerId: z.string().min(1).optional(),
    alertId: z.string().min(1).optional(),
    policyId: z.string().min(1).optional(),
    question: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((value) => (value.scope === 'request' ? value.requestId !== undefined : true), {
    message: 'scope "request" needs requestId',
  })
  .refine(
    (value) =>
      value.scope === 'engineer' || value.scope === 'route' ? value.engineerId !== undefined : true,
    {
      message: 'scope "engineer"/"route" needs engineerId',
    },
  )
  .refine((value) => (value.scope === 'alert' ? value.alertId !== undefined : true), {
    message: 'scope "alert" needs alertId',
  });
export type ExplainRequestDto = z.infer<typeof explainRequestSchema>;

/** Body of `POST /ai/alerts/:id/suggest`. */
export const suggestAlertResolutionSchema = z.object({ operationId: z.uuid() });
export type SuggestAlertResolutionDto = z.infer<typeof suggestAlertResolutionSchema>;
