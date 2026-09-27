import { t } from '../i18n';
export type DangerActionId = 'endDay' | 'restartDay' | 'resetData' | 'signOut';

export type DangerActionTone = 'bee' | 'danger';

export type DangerAction = {
  id: DangerActionId;
  title: string;
  word: string;
  warning: string;
  confirmLabel: string;
  tone: DangerActionTone;
};

export const DANGER_ACTIONS: Record<DangerActionId, DangerAction> = {
  endDay: {
    id: 'endDay',
    title: t('figma-dashboard.confirmPhrase.070512aa40'),
    word: t('figma-dashboard.confirmPhrase.57de74ebda'),
    warning: t('figma-dashboard.confirmPhrase.a8809a1aad'),
    confirmLabel: t('figma-dashboard.confirmPhrase.070512aa40'),
    tone: 'bee',
  },
  restartDay: {
    id: 'restartDay',
    title: t('figma-dashboard.confirmPhrase.79953852a9'),
    word: t('figma-dashboard.confirmPhrase.61d6e683a6'),
    warning: t('figma-dashboard.confirmPhrase.f2d4e06d96'),
    confirmLabel: t('figma-dashboard.confirmPhrase.79953852a9'),
    tone: 'danger',
  },
  resetData: {
    id: 'resetData',
    title: t('figma-dashboard.confirmPhrase.d613027d96'),
    word: t('figma-dashboard.confirmPhrase.6dae233da9'),
    warning: t('figma-dashboard.confirmPhrase.db0f71eeee'),
    confirmLabel: t('figma-dashboard.confirmPhrase.d613027d96'),
    tone: 'danger',
  },
  signOut: {
    id: 'signOut',
    title: t('figma-dashboard.confirmPhrase.5690c2e63b'),
    word: t('figma-dashboard.confirmPhrase.948fc1c763'),
    warning: t('figma-dashboard.confirmPhrase.39b3554372'),
    confirmLabel: t('figma-dashboard.confirmPhrase.5690c2e63b'),
    tone: 'danger',
  },
};

/** True when the typed value matches the shown confirmation word. */
export function phraseMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected;
}

/**
 * Confirm field accepts only keystrokes and deletions.
 * Paste, drop, autocorrect and other inserted payloads are rejected.
 */
export function isManualConfirmInput(inputType: string): boolean {
  return (
    inputType === 'insertText' ||
    inputType === 'insertCompositionText' ||
    inputType.startsWith('delete')
  );
}
