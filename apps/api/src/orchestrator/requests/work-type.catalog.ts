import type { Priority, Skill } from '../../generated/prisma/client';

/**
 * Work type to routing parameters.
 *
 * The client describes a problem; the required skill, the expected duration and any
 * transport restriction are formed by the system from the location and the type of work
 * (context/32 section 4.1). The customer never types a qualification code, and Router
 * never classifies free text.
 *
 * **These values are documented assumptions, not data.** The official dataset has a work
 * type but no duration, no priority and no skill (context/18 section 6.3), and the case
 * statement explicitly allows deriving them by a stated rule. The skill mapping follows
 * context/18 section 6.5; the durations are the midpoints of the ranges named there. They
 * are stored with `origin = synthesized` so that a derived value never looks like
 * something the customer supplied.
 *
 * `aliases` carry the exact wording used in the dataset. They exist so the importer maps
 * by a declared string rather than by guessing at an unfamiliar one: an unmapped type
 * fails its package instead of quietly becoming "some local work"
 * (context/37 section 9.1).
 */
export interface WorkTypeSpec {
  readonly code: string;
  /** The name shown to a customer choosing from the list. */
  readonly title: string;
  /** Exact spellings that appear in the official dataset. */
  readonly aliases: readonly string[];
  readonly skill: Skill;
  readonly serviceDurationSec: number;
  readonly priority: Priority;
}

const MINUTES = 60;

export const WORK_TYPES: readonly WorkTypeSpec[] = [
  // Emergency work: a service already in use has failed.
  {
    code: 'outage',
    title: 'Авария',
    aliases: ['Авария'],
    skill: 'emergency',
    serviceDurationSec: 90 * MINUTES,
    priority: 'urgent',
  },
  {
    code: 'no_link',
    title: 'Нет линка',
    aliases: ['Нет линка'],
    skill: 'emergency',
    serviceDurationSec: 90 * MINUTES,
    priority: 'urgent',
  },
  {
    code: 'disconnects',
    title: 'Разрывы',
    aliases: ['Разрывы'],
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'low_speed',
    title: 'Низкая скорость',
    aliases: ['Низкая скорость'],
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'port_errors',
    title: 'Рост ошибок на порту',
    aliases: ['Рост ошибок на порту'],
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'ip_169',
    title: 'IP-адрес 169...',
    aliases: ['IP-адрес 169...'],
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },

  // Connection work and additional orders.
  {
    code: 'connection_request',
    title: 'Заявка на подключение',
    aliases: ['Заявка на подключение'],
    skill: 'connection',
    serviceDurationSec: 75 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'convergence',
    title: 'Конвергенция абонента',
    aliases: ['Конвергенция абонента'],
    skill: 'connection',
    serviceDurationSec: 50 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'equipment_order',
    title: 'Дозаказ оборудования',
    aliases: ['Дозаказ оборудования', 'Заказ подключения/Дозаказ оборудования'],
    skill: 'connection',
    serviceDurationSec: 45 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'router_replacement',
    title: 'Роутер. Замена',
    aliases: ['Роутер. Замена', 'Роутер. Замена техническим специалистом'],
    skill: 'connection',
    serviceDurationSec: 35 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'stb_replacement',
    title: 'ТВ/TVE/ENT. Замена приставки',
    aliases: [
      'ТВ/TVE/ENT. Замена приставки',
      'TVE/ENT. Замена приставки техником',
      'ТВ. Замена приставки техником',
    ],
    skill: 'connection',
    serviceDurationSec: 35 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'gigabit_switch',
    title: 'Переключение на Гбит/с',
    aliases: ['Переключение на Гбит/с'],
    skill: 'connection',
    serviceDurationSec: 45 * MINUTES,
    priority: 'normal',
  },

  // Local work: performed on site, neither an outage nor a connection.
  {
    code: 'cable_work',
    title: 'Работа с кабелем',
    aliases: ['Работа с кабелем'],
    skill: 'local',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'monitoring',
    title: 'Мониторинг',
    aliases: ['Мониторинг'],
    skill: 'local',
    serviceDurationSec: 30 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'other_errors',
    title: 'TVE/ENT. Другие ошибки',
    aliases: ['TVE/ENT. Другие ошибки'],
    skill: 'local',
    serviceDurationSec: 40 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'information',
    title: 'Информация',
    aliases: ['Информация'],
    skill: 'local',
    serviceDurationSec: 30 * MINUTES,
    priority: 'normal',
  },
] as const;

const BY_CODE = new Map(WORK_TYPES.map((type) => [type.code, type]));

const BY_TITLE = new Map<string, WorkTypeSpec>();
for (const type of WORK_TYPES) {
  BY_TITLE.set(normalizeTitle(type.title), type);
  for (const alias of type.aliases) {
    BY_TITLE.set(normalizeTitle(alias), type);
  }
}

export function findWorkType(code: string): WorkTypeSpec | undefined {
  return BY_CODE.get(code);
}

/**
 * Resolves the wording used in the dataset.
 *
 * Returns `undefined` for anything not declared; the caller fails the package rather than
 * picking the nearest familiar type, because a wrong skill silently sends the wrong
 * engineer.
 */
export function findWorkTypeByTitle(title: string): WorkTypeSpec | undefined {
  return BY_TITLE.get(normalizeTitle(title));
}

/** Collapses whitespace and case so a stray double space does not lose a mapping. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const WORK_TYPE_CODES = WORK_TYPES.map((type) => type.code);
