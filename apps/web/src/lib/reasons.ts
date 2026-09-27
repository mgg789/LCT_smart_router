import { t } from '../i18n';

const FACTOR_LABELS: Record<string, string> = {
  skill_match: t('lib.reasons.3911162cca'),
  skill_missing: t('lib.reasons.af30f432b6'),
  equipment_ok: t('lib.reasons.0c4356c1f7'),
  equipment_missing: t('lib.reasons.a66b9a19d5'),
  travel_delta: t('lib.reasons.7cf1477c18'),
  sla_margin: t('lib.reasons.3791d1b8d0'),
  window_tight: t('lib.reasons.c7541f2a0f'),
  load_balance: t('lib.reasons.3c18885fec'),
  cluster: t('lib.reasons.adf9c4d408'),
  urgent_priority: t('lib.reasons.9e48878009'),
  CONSTRAINTS_SATISFIED: t('lib.reasons.0245b37a16'),
  NO_SKILL_MATCH: t('lib.reasons.af30f432b6'),
  NO_TRANSPORT_MATCH: t('lib.reasons.ce4157a6fe'),
  NO_EQUIPMENT_STOCK: t('lib.reasons.077fb337b0'),
  NO_AVAILABLE_ENGINEER: t('lib.reasons.c4283171cb'),
  NO_FEASIBLE_ASSIGNMENT_FOUND: t('lib.reasons.abc45d9d14'),
  LUNCH_NOT_PLACED: t('lib.reasons.11032943cf'),
  LUNCH_SKIPPED_FOR_WORK: t('lib.reasons.2d51485c5a'),
  REQUIRED_LUNCH_UNPLACED: t('lib.reasons.603d927202'),
};

const REASON_DETAILS: Record<string, string> = {
  CONSTRAINTS_SATISFIED: t('lib.reasons.d8a558d5c6'),
  NO_SKILL_MATCH: t('lib.reasons.002c118b7a'),
  NO_TRANSPORT_MATCH: t('lib.reasons.01289aa758'),
  NO_EQUIPMENT_STOCK: t('lib.reasons.9b3d0ddc4b'),
  NO_AVAILABLE_ENGINEER: t('lib.reasons.c5f6469c7d'),
  NO_FEASIBLE_ASSIGNMENT_FOUND: t('lib.reasons.4421360bef'),
  LUNCH_NOT_PLACED: t('lib.reasons.d0a8cc8da7'),
  LUNCH_SKIPPED_FOR_WORK: t('lib.reasons.21cb51876e'),
  REQUIRED_LUNCH_UNPLACED: t('lib.reasons.bb0ef6dc0a'),
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
  return FACTOR_LABELS[code] ?? t('lib.reasons.e7e8630767');
}

export function modeLabel(mode: 'auto' | 'manual'): string {
  return mode === 'auto' ? t('lib.reasons.8dca2f7831') : t('lib.reasons.3e17d77fcc');
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
  local: t('lib.reasons.64189f2d9f'),
  connection: t('lib.reasons.9bed4efc86'),
  emergency: t('lib.reasons.b1eb2830e9'),
};

export const SKILL_MARKS: Record<string, string> = {
  local: t('lib.reasons.a4af3e9a60'),
  connection: t('lib.reasons.1a37f2acd5'),
  emergency: t('lib.reasons.1d15dbf70d'),
};

export const TRANSPORT_LABELS: Record<string, string> = {
  car: t('lib.reasons.4af423e9b1'),
  walk: t('lib.reasons.12d94a87f5'),
  bike: t('lib.reasons.0469f75bb5'),
  // Legacy API snapshots used `transit`; the dispatcher UI now groups it with walking.
  transit: t('lib.reasons.12d94a87f5'),
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
  personal: t('lib.reasons.0a8232003c'),
  compact: t('lib.reasons.1024b68fd8'),
  fast: t('lib.reasons.0b6a715a58'),
  sla: t('lib.reasons.e5d759f5a5'),
  balanced: t('lib.reasons.94b4982ffa'),
  eco: t('lib.reasons.25907df14d'),
  covering: t('lib.reasons.0ae6737c4d'),
};

export const POLICY_DESCRIPTIONS: Record<string, string> = {
  compact: t('lib.reasons.e407aab96e'),
  fast: t('lib.reasons.6b628a24af'),
  sla: t('lib.reasons.581c0252dd'),
  balanced: t('lib.reasons.3723e50b4d'),
  eco: t('lib.reasons.2ae6aeca24'),
  covering: t('lib.reasons.66878ca8a0'),
  baseline: t('lib.reasons.051c2a5c7f'),
};
