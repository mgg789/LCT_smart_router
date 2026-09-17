const FACTOR_LABELS: Record<string, string> = {
  skill_match: 'Подходит навык',
  skill_missing: 'Нет нужного навыка',
  equipment_ok: 'Есть требуемое оборудование',
  equipment_missing: 'Нет оборудования',
  travel_delta: 'Близко к предыдущей точке',
  sla_margin: 'Начало внутри окна',
  window_tight: 'Окно узкое',
  load_balance: 'Выравнивает загрузку',
  cluster: 'В том же районе',
  urgent_priority: 'Срочная заявка',
  CONSTRAINTS_SATISFIED: 'Ограничения соблюдены',
  NO_SKILL_MATCH: 'Нет нужного навыка',
  NO_TRANSPORT_MATCH: 'Нет подходящего транспорта',
  NO_EQUIPMENT_STOCK: 'Нет нужного оборудования',
  NO_AVAILABLE_ENGINEER: 'Нет свободного инженера',
  NO_FEASIBLE_ASSIGNMENT_FOUND: 'Назначение не найдено',
  LUNCH_NOT_PLACED: 'Обед не поставлен',
  LUNCH_SKIPPED_FOR_WORK: 'Обед пропущен ради заявок',
  REQUIRED_LUNCH_UNPLACED: 'Обязательный обед не размещён',
};

const REASON_DETAILS: Record<string, string> = {
  CONSTRAINTS_SATISFIED: 'Навык, транспорт и расписание соблюдены.',
  NO_SKILL_MATCH: 'Нет инженера с нужным навыком.',
  NO_TRANSPORT_MATCH: 'Нет инженера с подходящим транспортом.',
  NO_EQUIPMENT_STOCK: 'Нет инженера с нужным оборудованием.',
  NO_AVAILABLE_ENGINEER: 'Нет свободного подходящего инженера.',
  NO_FEASIBLE_ASSIGNMENT_FOUND: 'Поиск не нашёл допустимого назначения.',
  LUNCH_NOT_PLACED: 'Обед не удалось поставить в этот маршрут.',
  LUNCH_SKIPPED_FOR_WORK: 'Обед пропущен, чтобы сохранить заявки.',
  REQUIRED_LUNCH_UNPLACED: 'Обязательный обед не удалось разместить.',
};

/**
 * Human label for a structured solver factor. The dashboard never invents a reason
 * string — it only translates a known code (context/11 §3).
 */
export function factorLabel(code: string): string {
  return FACTOR_LABELS[code] ?? code;
}

/**
 * Dispatcher-facing explanation. Solver `text` is English evidence; the UI
 * shows a Russian line for a known code and never dumps a Latin sentence.
 */
export function reasonDetail(code: string, fallback: string): string {
  const known = REASON_DETAILS[code];
  if (known) {
    return known;
  }
  if (hasCyrillic(fallback)) {
    return fallback;
  }
  return FACTOR_LABELS[code] ?? 'Подробности есть в данных расчёта.';
}

export function modeLabel(mode: 'auto' | 'manual'): string {
  return mode === 'auto' ? 'Авто' : 'Вручную';
}

function hasCyrillic(text: string): boolean {
  return /[А-Яа-яЁё]/.test(text);
}

export const ENGINEER_COLORS: Record<string, string> = {
  'eng-sokolov': '#1F8A4C',
  'eng-volkova': '#5B5CE6',
  'eng-alexandrov': '#E07A2F',
  'eng-petrov': '#2B6CB0',
};

export function engineerColor(engineerId: string): string {
  return ENGINEER_COLORS[engineerId] ?? '#5F6368';
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return `${first}${second}`.toUpperCase();
}

export const SKILL_LABELS: Record<string, string> = {
  local: 'локальные работы',
  connection: 'подключение',
  emergency: 'авария',
};

export const SKILL_MARKS: Record<string, string> = {
  local: 'Л',
  connection: 'П',
  emergency: 'А',
};

export const TRANSPORT_LABELS: Record<string, string> = {
  car: 'авто',
  walk: 'пешком',
  bike: 'велосипед',
  transit: 'общественный транспорт',
};

/** Dispatcher label for a stored skill code. Unknown codes stay as-is. */
export function skillLabel(skill: string): string {
  return SKILL_LABELS[skill] ?? skill;
}

/** Short map mark so the day map shows which skill the stop required. */
export function skillMark(skill: string): string {
  return SKILL_MARKS[skill] ?? skill.slice(0, 1).toUpperCase();
}

/** Dispatcher label for a stored transport code. */
export function transportLabel(transport: string): string {
  return TRANSPORT_LABELS[transport] ?? transport;
}

export const POLICY_LABELS: Record<string, string> = {
  compact: 'Компактнее — меньше инженеров',
  fast: 'Быстрее до клиента',
  sla: 'Бережнее к окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
  covering: 'Покрывающая — все заявки',
};

export const POLICY_DESCRIPTIONS: Record<string, string> = {
  compact: 'Больше выполненных заявок меньшим числом инженеров, затем короче пробег.',
  fast: 'Сначала покрытие срочных, затем меньше времени в пути.',
  sla: 'Покрытие заявок, затем запас до конца клиентского окна.',
  balanced: 'Покрытие заявок, затем ровная загрузка между инженерами.',
  eco: 'Покрытие заявок, затем короткий суммарный пробег.',
  covering:
    'Держит покрытие compact на штатном составе, затем добавляет минимум новых инженеров только на неназначенный остаток.',
  baseline:
    'Базовая из ТЗ: заявки по очереди поступления первому подходящему свободному инженеру. Нужна для сравнения, не как рабочая политика.',
};
