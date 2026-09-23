import type { z } from 'zod';
import type { Actor } from '../../auth';
import type { AiKnowledgeSegment } from '../../generated/prisma/client';

/**
 * What a tool's `run` needs to know about the session it executes inside of.
 *
 * The subject of every tool call -- which account, which engineer, which documents are
 * visible -- always comes from here, resolved once by `AiToolDispatcher` from the trusted
 * session that opened the conversation. No tool argument may re-supply any of it: see the
 * schema-invariant test in `test/unit/ai-tools.test.ts`, which is what keeps a later tool
 * from quietly reintroducing `engineerId` or `accountId` as a model-chosen argument.
 */
export interface ToolContext {
  readonly actor: Actor;
  readonly accountId: string;
  /** Set only when the actor resolves to an engineer profile. */
  readonly engineerId: string | null;
  readonly conversationId: string;
  readonly runId: string;
  /** Knowledge segments this profile may search, from `segmentsFor` in `role-profile.ts`. */
  readonly segments: readonly AiKnowledgeSegment[];
  /** Business-clock seconds this call started at (context/33 section 4: never
   *  `Date.now()` in place). */
  readonly now: number;
}

export interface ToolResult {
  readonly ok: boolean;
  /** Safe public summary for the `tool_result` run event (ai-event.types.ts). */
  readonly summary: string;
  /** Fed back to the model as the `tool` message's content on the next turn. */
  readonly resultContent: string;
}

/**
 * One entry of a role profile's tool catalogue.
 *
 * `schema` is authored with this workspace's zod 4 and converted to the JSON Schema the
 * provider boundary needs with `z.toJSONSchema()` (src/ai/provider/llm.types.ts's own
 * note on why); it is never handed to the SDK as a zod instance directly.
 *
 * `run` is declared with method shorthand rather than as a function-typed property on
 * purpose: TypeScript checks a method's parameters bivariantly, which is what lets a
 * concrete `ToolSpec<CreateRequestArgs>` sit next to every other tool in one
 * `readonly AnyToolSpec[]` catalogue (`ToolRegistry`) without a cast at every call site.
 * The parameter is still exactly `TArgs` at its own declaration -- each tool's `run` is as
 * strongly typed as ever; only the catalogue's own element type is erased to `unknown`.
 */
export interface ToolSpec<TArgs = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TArgs>;
  run(ctx: ToolContext, args: TArgs): Promise<ToolResult>;
}

/** Narrows a `ToolSpec<unknown>` catalogue entry back to a typed one where the argument
 *  shape is already known, without an `any` at the call site. */
export type AnyToolSpec = ToolSpec<unknown>;
