import { z } from 'zod';
import { operationEnvelopeSchema } from './request.dto';

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

export const postAiMessageSchema = operationEnvelopeSchema.extend({
  text: z.string().trim().min(1).max(4000),
});
export type PostAiMessageDto = z.infer<typeof postAiMessageSchema>;

export const afterSeqQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
});
export type AfterSeqQueryDto = z.infer<typeof afterSeqQuerySchema>;
