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
};

/**
 * Human label for a structured solver factor. The dashboard never invents a reason
 * string — it only translates a known code (context/11 §3).
 */
export function factorLabel(code: string): string {
  return FACTOR_LABELS[code] ?? code;
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

export const POLICY_LABELS: Record<string, string> = {
  compact: 'Компактнее — меньше инженеров',
  fast: 'Быстрее до клиента',
  sla: 'Бережнее к окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
};
