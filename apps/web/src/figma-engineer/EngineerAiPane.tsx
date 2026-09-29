import { PhoneAiPane } from '../components/ai/PhoneAiPane';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { t } from '../i18n';

/** First-turn prompts for route context, problem triage and retaining checks already done. */
export const ENGINEER_QUICK_QUESTIONS = [
  t('figma-engineer.EngineerAiPane.176369bc5c'),
  t('figma-engineer.EngineerAiPane.7b0bae4276'),
  t('figma-engineer.EngineerAiPane.4917c6fbc2'),
] as const;

/**
 * First name for the empty greeting. A missing profile stays unnamed: the frame's
 * "Илья" is a sample, not this engineer's name.
 */
export function engineerGreeting(displayName: string | null | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0 || first === t('figma-engineer.EngineerAiPane.88d71676fa'))
    return t('figma-engineer.EngineerAiPane.8e356a4b41');
  return t('figma-engineer.EngineerAiPane.b33fce20e1', { value0: first });
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
  surface = 'engineer',
  sessionScope,
  onSessionExpired,
  avatarSrc = FIGMA_ASSETS.aiKolobokEngineer,
  quickQuestions = ENGINEER_QUICK_QUESTIONS,
  onOperationApplied,
  onOpenObject,
  active = true,
  onInbox,
}: {
  token: string | null;
  displayName: string | null;
  surface?: 'engineer' | 'client';
  sessionScope?: string;
  onSessionExpired?: () => void;
  avatarSrc?: string;
  quickQuestions?: readonly string[];
  onOperationApplied?: () => void;
  onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
  active?: boolean;
  onInbox?: (report: { seq: number; preview: string; active: boolean }) => void;
}) {
  return (
    <PhoneAiPane
      token={token}
      surface={surface}
      sessionScope={sessionScope}
      onSessionExpired={onSessionExpired}
      onOperationApplied={onOperationApplied}
      onOpenObject={onOpenObject}
      active={active}
      onInbox={onInbox}
      greeting={engineerGreeting(displayName)}
      quickQuestions={quickQuestions}
      avatar={avatarSrc}
    />
  );
}
