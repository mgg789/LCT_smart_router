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

/**
 * Who the dispatcher wants to write to.
 *
 * A request or an engineer, never an account id: every button that opens a chat sits next
 * to one of those two, and resolving the account on the server keeps one person's account
 * id out of another person's browser. The discriminated union is deliberate -- an object
 * with both ids, or with neither, is a caller bug and should be refused by the schema
 * rather than resolved by precedence.
 */
export const dispatchChatTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), requestId: z.uuid() }),
  z.object({ kind: z.literal('engineer'), engineerId: z.uuid() }),
]);
export type DispatchChatTargetDto = z.infer<typeof dispatchChatTargetSchema>;

/** `POST /dispatch/chats`: open (or re-enter) a chat with a client or an engineer. The
 *  opening `text` is optional -- pressing the button to read someone's history before
 *  deciding what to say is a normal thing to do. */
export const openDispatchChatSchema = operationEnvelopeSchema.extend({
  target: dispatchChatTargetSchema,
  text: z.string().trim().min(1).max(4000).optional(),
});
export type OpenDispatchChatDto = z.infer<typeof openDispatchChatSchema>;

/** `POST /dispatch/chats/:id/read`: the dispatcher has seen everything up to `seq`. The
 *  cursor only ever moves forward, so a stale tab replaying an old value changes nothing. */
export const readDispatchChatSchema = operationEnvelopeSchema.extend({
  seq: z.coerce.number().int().nonnegative(),
});
export type ReadDispatchChatDto = z.infer<typeof readDispatchChatSchema>;

/** `GET /dispatch/chats`: how many finished chats to carry alongside the live ones. */
export const listDispatchChatsQuerySchema = z.object({
  closedLimit: z.coerce.number().int().nonnegative().max(200).default(30),
});
export type ListDispatchChatsQueryDto = z.infer<typeof listDispatchChatsQuerySchema>;
