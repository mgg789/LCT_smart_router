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

interface TomorrowRequest {
  readonly id: string;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
}

/**
 * How many other requests already sit in this visit's window tomorrow.
 *
 * Moving the visit there does not create capacity: each overlapping request
 * needs its own engineer on shift at that moment. The closing count adds
 * this request: that is the load `reschedule` would create.
 */
export function tomorrowCrewLine(input: {
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly others: readonly TomorrowRequest[];
}): string {
  const start = input.windowStartAt + 86_400;
  const end = input.windowEndAt + 86_400;
  const dayStart = moscowDayStart(start);
  const overlapping = input.others
    .filter(
      (item) =>
        item.windowStartAt >= dayStart &&
        item.windowStartAt < dayStart + 86_400 &&
        item.windowStartAt < end &&
        item.windowEndAt > start,
    )
    .sort((left, right) => left.windowStartAt - right.windowStartAt);
  const already = overlapping.length;
  const together = already + 1;
  const listed = overlapping
    .slice(0, 6)
    .map(
      (item) =>
        `${item.id.slice(0, 8)} ${moscowClock(item.windowStartAt)}–${moscowClock(item.windowEndAt)}`,
    )
    .join(', ');
  const names = listed.length > 0 ? ` Уже стоят: ${listed}.` : '';
  const clock = `${moscowClock(start)}–${moscowClock(end)}`;
  return (
    `На завтра в окно ${clock} уже ${ruCount(already, 'заявка', 'заявки', 'заявок')}.` +
    `${names} ${engineerShift(already)}, чтобы одновременно решать заявку в этот момент.` +
    ` Если перенести и эту, одновременно будут ${ruCount(together, 'заявка', 'заявки', 'заявок')}: ${engineerShift(together)}.`
  );
}

/** Moscow midnight at or before `unix`, as Unix seconds. */
function moscowDayStart(unix: number): number {
  const shifted = unix + MOSCOW_OFFSET_SEC;
  return Math.floor(shifted / 86_400) * 86_400 - MOSCOW_OFFSET_SEC;
}

function engineerShift(count: number): string {
  const word = ruCount(count, 'инженер', 'инженера', 'инженеров');
  const verb = count % 10 === 1 && count % 100 !== 11 ? 'должен выйти' : 'должны выйти';
  return `${word} ${verb} на смену`;
}

function ruCount(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? one
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? few
        : many;
  return `${count} ${word}`;
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
