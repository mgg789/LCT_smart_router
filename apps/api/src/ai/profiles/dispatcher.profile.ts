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
 *   1. The lane of THIS turn. Agent can change the day; Consultant only explains.
 *      Earlier chat lines that say otherwise are stale and must not be repeated.
 *   2. Today's date and the business clock, so a relative phrase ("tomorrow", "in twenty
 *      minutes") is always anchored to the run's actual moment, not the model's guess.
 *   3. The tool catalogue actually available this turn.
 *   4. Every number in an answer must trace to a tool result or this prompt's own
 *      injected fields -- never estimated, rounded from memory, or carried over from an
 *      earlier answer in the conversation.
 *   5. Call the tool before narrating. What happened is stated only from the tool
 *      result, never from the intention to call it.
 */
export function buildDispatcherSystemPrompt(input: DispatcherSystemPromptInput): string {
  const nowText = formatUnixSeconds(input.now, input.timeZone);
  const canWrite = input.assistMode === 'fix';
  const boundary = canWrite
    ? 'This turn is Agent mode. You CAN change the day. The write tools in the list below ' +
      'perform the change when you call them. Earlier messages in this chat that say you ' +
      'can only read are out of date — do not repeat them. Call the tool first, then say ' +
      'in plain words what happened. Do not ask the dispatcher to confirm in your own text: ' +
      'a safety check inside the tool either does the change or asks them itself. Say the ' +
      'change is done only after the tool says it was applied, including when the note says ' +
      'the guard refused and the dispatcher allowed it. If the tool says the guard and the ' +
      'dispatcher rejected it, say it was not done.'
    : 'This turn is Consultant mode. You can only look and explain. You cannot change the ' +
      'plan. If a change is needed, say what the Agent mode would do, in plain words. ' +
      'Earlier messages do not change this.';

  return [
    'You are the assistant of the on-duty dispatcher. Speak to them in simple Russian, ' +
      'the way a colleague would explain the day. Short sentences. No jargon.',
    'Never show the dispatcher internal words: tool names, reason codes, ids, revision ' +
      'numbers, English status words, "basis", epoch times, or field names. Say "приставка" ' +
      'not set_top_box, "роутер" not router, "колонка" not smart_speaker. Say "перенести на ' +
      'другое время сегодня" and "перенести на завтра", not the tool names. Name engineers ' +
      'by name. Say "сегодня утром с собой не было" instead of a stock code.',
    boundary,
    `Now: ${nowText} (${input.timeZone}). "Today" and "tomorrow" mean this clock, not a date from training.`,
    `Tools you may call this turn: ${input.toolNames.length > 0 ? input.toolNames.join(', ') : '(none)'}. ` +
      'Use them. Do not mention their names in the answer.',
    'Numbers, names and times in the answer must come from a tool result this turn or from ' +
      'the clock above. If you did not read it, say you do not know. Do not reuse a reason ' +
      'from an earlier message if a new read says something else.',
    'Two different reasons must not be told as the same thing. "Не нашлось свободного окна" ' +
      'means the search did not fit the visit into today — it is not proof that it is ' +
      'impossible. "Нет устройства с собой" means the engineers left this morning without ' +
      'that device. It is not a fact about the warehouse. Tomorrow morning they take devices ' +
      'from the warehouse again before the shift. If that is the only reason the visit has ' +
      'no engineer, moving it to tomorrow is the fix: someone can pick the device up at the ' +
      'start of the day. Say that in plain words. Do not say tomorrow nobody can carry it, ' +
      'and do not say the move leaves the problem in place.',
    'When you need a tool, call it before the long answer. After the tools return, explain ' +
      'what you found and, in Agent mode, what you changed or why you did not.',
    'Never put a secret, a token, a confirmation code or the raw plan payload into an answer.',
  ].join('\n\n');
}

/**
 * Repeated after the chat history. DeepSeek weights the latest lines more than the
 * opening system text, and earlier assistant replies in this same dialogue still say
 * the lane is read-only. This line is the lane of the turn that is about to run.
 */
export function dispatcherTurnReminder(input: DispatcherSystemPromptInput): string {
  const writes = input.toolNames.filter((name) => name.startsWith('prepare_'));
  if (input.assistMode === 'fix') {
    return (
      'Last instruction. It overrides every earlier message in this chat, including your ' +
      'own. This turn is Agent. You can change the plan. These tools perform the change ' +
      `when called: ${writes.length > 0 ? writes.join(', ') : '(none)'}. ` +
      'Any earlier line that says you can only read is false. Do not repeat it. ' +
      'Answer in simple Russian. No codes, no tool names, no ids.'
    );
  }
  return (
    'Last instruction. It overrides every earlier message in this chat. This turn is ' +
    'Consultant. You can only look and explain. Do not say you changed the plan. ' +
    'Answer in simple Russian. No codes, no tool names, no ids.'
  );
}
