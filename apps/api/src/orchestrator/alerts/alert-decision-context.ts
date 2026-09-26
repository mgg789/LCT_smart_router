import type { AlertAction } from './alert-policy';

const MOSCOW_OFFSET_SEC = 3 * 60 * 60;

const REGION_LABEL: Record<string, string> = {
  east: 'восточный',
  southeast: 'юго-восточный',
  south_central: 'южный',
};

const SKILL_LABEL: Record<string, string> = {
  local: 'локальные работы',
  connection: 'подключение',
  emergency: 'авария',
};

interface ActionSpec {
  readonly role: 'обычный' | 'сильный' | 'крайний';
  readonly benefit: string;
  readonly drawback: string;
}

/**
 * Role and price of one catalogue action.
 * Last-resort rows state the client or engineer cost in the card itself.
 */
const ACTION_SPEC: Record<AlertAction, ActionSpec> = {
  reschedule: {
    role: 'крайний',
    benefit: 'Снимает сегодняшний риск и сохраняет длительность окна.',
    drawback: 'Клиент ждёт ещё сутки. Это большая потеря для клиента.',
  },
  move_window: {
    role: 'обычный',
    benefit: 'Оставляет визит сегодня в одном из найденных слотов.',
    drawback: 'Новое время нужно согласовать с клиентом, назначение пересчитается.',
  },
  add_engineer: {
    role: 'сильный',
    benefit: 'Вызывает человека вне линии с нужным навыком и регионом.',
    drawback: 'Рабочий состав меняется только если этот вариант выбран.',
  },
  keep_manual: {
    role: 'обычный',
    benefit: 'Сохраняет уже выданный ручной порядок.',
    drawback: 'План может быть хуже автоматического.',
  },
  keep_as_is: {
    role: 'обычный',
    benefit: 'Не меняет согласованный маршрут.',
    drawback: 'Причина риска остаётся.',
  },
  restore_auto: {
    role: 'сильный',
    benefit: 'Возвращает актуальный автоматический план.',
    drawback: 'Маршруты нескольких инженеров могут измениться.',
  },
  skip_lunch: {
    role: 'сильный',
    benefit: 'Освобождает время под заявки.',
    drawback: 'Инженер остаётся без обеда.',
  },
  keep_lunch: {
    role: 'обычный',
    benefit: 'Сохраняет перерыв.',
    drawback: 'Часть заявок может остаться без назначения.',
  },
  message: {
    role: 'обычный',
    benefit: 'Инженер получает письмо и остаётся на смене.',
    drawback: 'Само по себе не двигает маршрут.',
  },
  remove_shift: {
    role: 'крайний',
    benefit: 'Снимает инженера, только если он точно не выйдет.',
    drawback:
      'Работы уходят другим без вопроса инженеру. Сначала уместнее письмо или продление ожидания.',
  },
  message_remove: {
    role: 'крайний',
    benefit: 'Сначала предупреждает, затем снимает со смены.',
    drawback: 'Инженер теряет оставшиеся заявки дня, не ответив на письмо.',
  },
  extend: {
    role: 'обычный',
    benefit: 'Даёт ещё 15, 30 или 60 минут выйти на связь.',
    drawback: 'Риск не исчезает, пока отметки нет.',
  },
};

/** Moscow wall clock `ЧЧ:ММ` from a Unix second. */
export function moscowClock(unix: number): string {
  const date = new Date((unix + MOSCOW_OFFSET_SEC) * 1000);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** Region id as the dispatcher sees it. Unknown ids stay as stored. */
export function regionLabel(region: string | null | undefined): string {
  if (!region) return 'регион не указан';
  return REGION_LABEL[region] ?? region;
}

/** Skill id as a short Russian phrase. Unknown ids stay as stored. */
export function skillLabel(skill: string | null | undefined): string {
  if (!skill) return 'навык не указан';
  return SKILL_LABEL[skill] ?? skill;
}

/**
 * One block System one reads before it picks an action id.
 * Every allowed action is a card. The case numbers are repeated on each card.
 */
export function decisionState(input: {
  readonly code: string;
  readonly reasons: readonly string[];
  readonly facts: string;
  readonly windows: readonly string[];
  readonly engineers: readonly string[];
  readonly actions: readonly AlertAction[];
}): string {
  const reasons = input.reasons.length > 0 ? input.reasons.join('; ') : 'причин в записи нет';
  const windows =
    input.windows.length > 0 ? input.windows.join(' | ') : 'сегодня выполнимого окна нет';
  const engineers =
    input.engineers.length > 0 ? input.engineers.join(' | ') : 'подходящих инженеров вне линии нет';
  const cards = input.actions.map((action) => {
    const spec = ACTION_SPEC[action];
    return [
      `${action} — ${spec.role}.`,
      `Польза: ${spec.benefit}`,
      `Цена: ${spec.drawback}`,
      `Факты случая: ${input.facts}`,
    ].join(' ');
  });
  return [
    `Алерт ${input.code}. Причины: ${reasons}.`,
    `Случай: ${input.facts}`,
    `Окна на сегодня: ${windows}`,
    `Инженеры вне линии: ${engineers}`,
    'Варианты:',
    ...cards,
  ].join('\n');
}
