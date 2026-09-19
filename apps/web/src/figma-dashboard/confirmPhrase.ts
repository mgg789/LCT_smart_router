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
    title: 'Завершить день',
    word: 'ЗАВЕРШИТЬ',
    warning:
      'Смена закроется, и дашборд скроется. Данные дня останутся. Чтобы снова открыть план, нужно нажать «Начать рабочий день».',
    confirmLabel: 'Завершить день',
    tone: 'bee',
  },
  restartDay: {
    id: 'restartDay',
    title: 'День заново',
    word: 'ЗАНОВО',
    warning:
      'План заменится исходным демо-набором, а экран вернётся к приветствию. Назначения и правки этой сессии пропадут.',
    confirmLabel: 'День заново',
    tone: 'danger',
  },
  resetData: {
    id: 'resetData',
    title: 'Сбросить данные',
    word: 'СБРОС',
    warning:
      'Текущий день заменится исходным демо-набором. Назначения и правки этой сессии пропадут, вы останетесь в дашборде.',
    confirmLabel: 'Сбросить данные',
    tone: 'danger',
  },
  signOut: {
    id: 'signOut',
    title: 'Выйти',
    word: 'ВЫЙТИ',
    warning:
      'Сессия диспетчера закроется, локальный кэш дня очистится. Чтобы вернуться, нужно войти снова.',
    confirmLabel: 'Выйти',
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
  return inputType === 'insertText' || inputType === 'insertCompositionText' || inputType.startsWith('delete');
}
