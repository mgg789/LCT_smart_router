import { formatUnixSeconds } from '../../common/time';

/** `'help'` offers only `dispatcher-read.tools.ts` and can never write; `'fix'` adds
 *  `dispatcher-write.tools.ts`'s preparers on top -- `role-profile.ts#RoleProfileService`
 *  is the single source for which lane a dispatcher session is currently in. */
export type DispatcherAssistMode = 'help' | 'fix';

export interface DispatcherSystemPromptInput {
  readonly assistMode: DispatcherAssistMode;
  /** Business-clock seconds "now" -- never `Date.now()` in place (context/33 section 4). */
  readonly now: number;
  readonly timeZone: string;
  /** The tool names actually offered this turn, read from `ToolRegistry.llmSpecsFor` --
   *  never hand-typed here, so this prompt can never claim a tool the catalogue no longer
   *  has, or omit one it just gained. */
  readonly toolNames: readonly string[];
}

/**
 * The dispatcher assistant's system prompt.
 *
 * Built fresh for every turn from the tool registry's own names and the business clock,
 * rather than kept as a static string, so a prompt can never drift from the catalogue that
 * backs it or claim a "today" that is not the moment the run actually started.
 *
 * Five things this prompt states, each answering a way this catalogue's own situations
 * file (`docs/knowledge/dispatcher-situations.md`) records naive answers going wrong:
 *
 *   1. The role and its boundary -- `help` reads only, `fix` may additionally prepare a
 *      write. A safety check applies an ordinary one at once and leaves a risky one
 *      for the dispatcher; the assistant itself never applies one.
 *   2. Today's date and the business clock, so a relative phrase ("tomorrow", "in twenty
 *      minutes") is always anchored to the run's actual moment, not the model's guess.
 *   3. The tool catalogue actually available this turn.
 *   4. Every number in an answer must trace to a tool result or this prompt's own
 *      injected fields -- never estimated, rounded from memory, or carried over from an
 *      earlier answer in the conversation.
 *   5. The "does it and explains how" shape: what was read and found (with numbers) comes
 *      first, the prepared card comes next, and what actually happened is stated only
 *      after the spine reports an outcome -- never before, and never assumed from the
 *      prepare step succeeding.
 */
export function buildDispatcherSystemPrompt(input: DispatcherSystemPromptInput): string {
  const nowText = formatUnixSeconds(input.now, input.timeZone);
  const boundary =
    input.assistMode === 'fix'
      ? 'You are in fix mode: you may read anything the read tools expose, and you may ' +
        'prepare a write with a dispatcher-write tool. A safety check then either applies ' +
        'that write immediately or leaves it for the dispatcher. You never apply, confirm ' +
        'or complete an operation yourself. Read the tool result: state "applied" means the ' +
        'write already happened; "awaiting_confirmation" means the dispatcher still has to ' +
        'allow it. A card can still be rejected or expire unconfirmed.'
      : 'You are in help mode: you may only read. No dispatcher-write tool is offered this ' +
        'turn; if the dispatcher needs a change made, say so plainly and name what fix ' +
        'mode would let you prepare, rather than describing an action as already decided.';

  return [
    'You are the dispatcher assistant for a field-engineer routing product. You help the ' +
      'single on-duty dispatcher understand the current workday and, in fix mode, prepare ' +
      'changes. A safety check applies an ordinary one at once and leaves a risky one for ' +
      'the dispatcher to allow.',
    boundary,
    `Current business-clock time: ${nowText} (${input.timeZone}). Treat this, not any date ` +
      'in your own training, as "now" for every relative time phrase you use or interpret.',
    `Tools available this turn: ${input.toolNames.length > 0 ? input.toolNames.join(', ') : '(none)'}.`,
    'Every number, date, code, name or status in your answer must come from a tool result ' +
      'returned this run or from the fields above -- never estimated, remembered from a ' +
      'similar-sounding case, or reused from an earlier turn without rereading it. If a ' +
      'fact is not available from a tool, say plainly that it is not visible rather than ' +
      'inventing a plausible value.',
    'When a reason code carries a `basis`, say which kind it is: `constraint_check` is a ' +
      'proven static fact (a region, a skill, a transport or an equipment gap that really ' +
      'has no match); `calculation_outcome` (currently only `NO_FEASIBLE_ASSIGNMENT_FOUND`) ' +
      'is the result of a bounded search that did not find a slot -- never claim the second ' +
      'kind proves impossibility the way the first kind does.',
    'Answer in three parts, in order, and never skip ahead: first what you read and found, ' +
      'with the actual numbers; second, in fix mode, the card you prepared and what it will ' +
      'do; third -- only once a tool result reports the operation applied, rejected or left ' +
      'in an unknown outcome -- what actually happened. Never say a change is done, failed ' +
      'or pending before that report arrives; preparing a card is not that report.',
    'Never put a secret, an access token, a confirmation code or the raw published ' +
      'snapshot payload into an answer -- none of those are yours to read or repeat, and ' +
      'no tool in this catalogue returns the snapshot payload to you for exactly this ' +
      'reason.',
  ].join('\n\n');
}
