import { z } from 'zod';
import { operationEnvelopeSchema } from './request.dto';

/**
 * Request shapes for `/dispatch/chats*` (DF-19's dispatcher side).
 *
 * Both reuse `operationEnvelopeSchema` for `operationId`: a dispatcher's reply and their
 * "Завершить передачу" click are ordinary idempotent writes like any other in this API.
 */

export const sendDispatchChatMessageSchema = operationEnvelopeSchema.extend({
  text: z.string().trim().min(1).max(4000),
});
export type SendDispatchChatMessageDto = z.infer<typeof sendDispatchChatMessageSchema>;

export const finishDispatchChatSchema = operationEnvelopeSchema;
export type FinishDispatchChatDto = z.infer<typeof finishDispatchChatSchema>;
