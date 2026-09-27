import { PhoneAiPane } from '../components/ai/PhoneAiPane';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';

/** First-turn prompts for route context, problem triage and retaining checks already done. */
export const ENGINEER_QUICK_QUESTIONS = [
  'Покажи контекст моего выезда',
  'Помоги разобраться в проблеме',
  'Я уже проверил … что дальше?',
] as const;

/**
 * First name for the empty greeting. A missing profile stays unnamed: the frame's
 * "Илья" is a sample, not this engineer's name.
 */
export function engineerGreeting(displayName: string | null | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0 || first === 'Инженер') return 'С чего начнем сегодня?';
  return `${first}, с чего начнем сегодня?`;
}

/**
 * Engineer assistant, drawn to the phone frames 72:8811 and 72:8913.
 *
 * Only the wording is the engineer's; the screen itself is `PhoneAiPane`, which
 * the client shows too — both apps talk into the same kind of dialogue and both
 * receive a dispatcher's answer in it.
 */
export function EngineerAiPane({
  token,
  displayName,
}: {
  token: string | null;
  displayName: string | null;
}) {
  return (
    <PhoneAiPane
      token={token}
      surface="engineer"
      greeting={engineerGreeting(displayName)}
      quickQuestions={ENGINEER_QUICK_QUESTIONS}
      avatar={FIGMA_ASSETS.aiKolobokEngineer}
    />
  );
}
