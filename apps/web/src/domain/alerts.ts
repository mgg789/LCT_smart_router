import type { AlertView } from '../api/types';

export type AlertActionId =
  | 'reschedule'
  | 'move_window'
  | 'add_engineer'
  | 'keep_manual'
  | 'keep_as_is'
  | 'restore_auto'
  | 'skip_lunch'
  | 'keep_lunch'
  | 'message'
  | 'remove_shift'
  | 'message_remove'
  | 'extend';

export type AlertActionTone = 'bee' | 'outline' | 'ink';

export interface AlertActionSpec {
  readonly id: AlertActionId;
  readonly label: string;
  readonly summary: string;
  readonly effect: string;
  readonly benefit: string;
  readonly drawback: string;
  readonly tone: AlertActionTone;
  readonly input: 'none' | 'window' | 'engineer' | 'reason' | 'minutes' | 'message';
}

/**
 * UI copy for the server's finite dispatcher decisions. Labels stay short while
 * the hover/focus explanation names the real mutation, benefit and trade-off.
 */
export const ALERT_ACTION_SPECS: Readonly<Record<AlertActionId, AlertActionSpec>> = {
  reschedule: {
    id: 'reschedule',
    label: 'На завтра',
    summary: 'Перенести заявку на следующий календарный день, сохранив часы окна.',
    effect: 'Система сдвинет обе границы окна на 24 часа и отправит заявку на перепланирование.',
    benefit: 'Снимает текущий риск и сохраняет длительность согласованного окна.',
    drawback: 'Клиент получит услугу позже; сегодняшняя заявка исчезнет из плана.',
    tone: 'outline',
    input: 'none',
  },
  move_window: {
    id: 'move_window',
    label: 'Сменить окно',
    summary: 'Задать заявке новое точное окно обслуживания по московскому времени.',
    effect: 'Система сохранит новые границы и отправит заявку на перепланирование.',
    benefit: 'Позволяет найти выполнимое время без переноса на другой день.',
    drawback: 'Новое окно нужно заранее согласовать с клиентом.',
    tone: 'bee',
    input: 'window',
  },
  add_engineer: {
    id: 'add_engineer',
    label: 'Добавить инженера',
    summary: 'Подключить к текущей смене подходящего инженера, который сейчас вне линии.',
    effect: 'Инженер станет доступен для планирования, будет создано почтовое уведомление.',
    benefit: 'Добавляет доступную мощность и повышает шанс выполнить заявку сегодня.',
    drawback: 'Требует свободного инженера нужного региона, навыка, транспорта и смены.',
    tone: 'ink',
    input: 'engineer',
  },
  keep_manual: {
    id: 'keep_manual',
    label: 'Сохранить план',
    summary: 'Подтвердить текущий ручной план, несмотря на обнаруженное ухудшение.',
    effect: 'Система сохранит ручной режим и обязательную причину решения.',
    benefit: 'Сохраняет диспетчерскую договорённость и уже выданный порядок работ.',
    drawback: 'План может быть хуже доступного автоматического варианта.',
    tone: 'outline',
    input: 'reason',
  },
  keep_as_is: {
    id: 'keep_as_is',
    label: 'Оставить как есть',
    summary: 'Принять текущий риск без изменения заявки или плана.',
    effect: 'Алерт закроется с зафиксированным решением диспетчера.',
    benefit: 'Не меняет уже согласованный маршрут и условия визита.',
    drawback: 'Причина риска остаётся, поэтому возможна просрочка.',
    tone: 'outline',
    input: 'none',
  },
  restore_auto: {
    id: 'restore_auto',
    label: 'Вернуть AUTO',
    summary: 'Вернуться к актуальному автоматическому варианту Router.',
    effect: 'Система включит AUTO; алерт закроется только после фактического применения плана.',
    benefit: 'Использует лучший доступный вариант для текущих входных данных.',
    drawback: 'Маршруты и назначения могут измениться для нескольких инженеров.',
    tone: 'bee',
    input: 'none',
  },
  skip_lunch: {
    id: 'skip_lunch',
    label: 'Убрать обед',
    summary: 'Отключить обед для выбранной смены инженера.',
    effect: 'Система снимет требование обеда и отправит день на перепланирование.',
    benefit: 'Освобождает время для выполнения заявок.',
    drawback: 'Инженер останется без запланированного перерыва на обед.',
    tone: 'ink',
    input: 'none',
  },
  keep_lunch: {
    id: 'keep_lunch',
    label: 'Сохранить обед',
    summary: 'Сохранить обязательный обед и перепланировать остальные работы вокруг него.',
    effect: 'Система отметит обед обязательным и отправит день на перепланирование.',
    benefit: 'Сохраняет перерыв инженера в рабочем дне.',
    drawback: 'Часть заявок может сдвинуться или остаться без назначения.',
    tone: 'bee',
    input: 'none',
  },
  message: {
    id: 'message',
    label: 'Написать инженеру',
    summary: 'Отправить инженеру сообщение и продолжить ждать его отметку.',
    effect: 'Система создаст почтовое уведомление на привязанный адрес.',
    benefit: 'Даёт шанс быстро уточнить статус без изменения смены.',
    drawback: 'Не гарантирует ответ и само по себе не меняет маршрут.',
    tone: 'bee',
    input: 'message',
  },
  remove_shift: {
    id: 'remove_shift',
    label: 'Снять со смены',
    summary: 'Убрать инженера из активной смены на этот день.',
    effect:
      'Система снимет инженера с линии, отключит ожидание явки и отправит работы на перепланирование.',
    benefit: 'План перестанет рассчитывать на недоступного инженера.',
    drawback: 'Его заявки придётся перераспределить между оставшимися инженерами.',
    tone: 'ink',
    input: 'none',
  },
  message_remove: {
    id: 'message_remove',
    label: 'Написать и снять',
    summary: 'Одновременно уведомить инженера и снять его с текущей смены.',
    effect:
      'Система создаст письмо, снимет инженера с линии и отправит работы на перепланирование.',
    benefit: 'Фиксирует решение и сразу освобождает его заявки для других.',
    drawback: 'Инженер исключается из плана, даже если ответит позднее.',
    tone: 'ink',
    input: 'message',
  },
  extend: {
    id: 'extend',
    label: 'Продлить ожидание',
    summary: 'Продлить время ожидания отметки инженера.',
    effect: 'Система перенесёт контрольный срок; для неявки продление всегда равно 15 минутам.',
    benefit: 'Сохраняет текущий план, если инженер скоро появится.',
    drawback: 'При дальнейшей неявке перепланирование начнётся позже.',
    tone: 'outline',
    input: 'minutes',
  },
};

/** Short labels retained for history rows and other existing alert projections. */
export const ALERT_ACTION_LABELS: Readonly<Record<AlertActionId, string>> = Object.fromEntries(
  Object.values(ALERT_ACTION_SPECS).map((spec) => [spec.id, spec.label]),
) as Readonly<Record<AlertActionId, string>>;

/** Narrows untrusted action ids supplied by live or cached server snapshots. */
export function isAlertActionId(value: string): value is AlertActionId {
  return Object.hasOwn(ALERT_ACTION_SPECS, value);
}

/** Resolves known event codes without losing unknown server events. */
export function alertTitle(code: string): string {
  const titles: Readonly<Record<string, string>> = {
    time_risk: 'Риск времени',
    engineer_line_started: 'Инженер вышел на линию',
    engineer_day_finished: 'Инженер завершил день',
    workday_finished_with_alerts: 'Остались нерешённые алерты',
    unassigned: 'Заявка не назначена',
    plan_degraded: 'План деградировал',
    plan_review_required: 'Ручной план требует проверки',
    lunch_conflict: 'Конфликт с обедом',
    engineer_overdue: 'Инженер задержался и не отмечается',
    shift_no_show: 'Не вышел на смену',
    plan_rebuilt: 'План перестроился',
    LIVE_TECHNICAL_BREAK_OVERRUN: 'Риск времени',
    LIVE_WINDOW_COMPLETION_RISK: 'Риск времени',
  };
  return titles[code] ?? code;
}

/** Read status never removes the requirement for a dispatcher decision. */
export function isOpenAlert(alert: AlertView): boolean {
  return alert.kind !== 'notice' && alert.resolvedAt === null;
}

/** The first 180 seconds are a grace period; elapsed second 181 is recorded as 1. */
export function alertDecisionSeconds(alert: AlertView, now: number): number {
  return alert.resolutionDelaySec ?? Math.max(0, (alert.resolvedAt ?? now) - alert.createdAt - 180);
}

/** Converts the UI's explicitly Moscow datetime input into Unix seconds. */
export function alertWindowSeconds(value: string): number {
  const result = Date.parse(`${value}:00+03:00`) / 1000;
  if (!Number.isInteger(result)) throw new Error('Укажите корректную дату и время окна');
  return result;
}

/** Formats persisted Unix time for a Moscow datetime-local input. */
export function alertWindowInput(seconds: number): string {
  return new Date((seconds + 3 * 3600) * 1000).toISOString().slice(0, 16);
}
