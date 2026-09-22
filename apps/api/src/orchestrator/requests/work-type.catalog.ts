import type { Priority, Skill } from '../../generated/prisma/client';

/**
 * Work type to routing parameters.
 *
 * The client describes a problem; the required skill, the expected duration and any
 * transport restriction are formed by the system from the location and the type of work
 * (context/32 section 4.1). The customer never types a qualification code, and Router
 * never classifies free text.
 *
 * The official dataset has a work type but no duration, priority or skill (context/18
 * section 6.3). Skills and priorities follow the documented derivation rules; duration
 * components come from the supplied normative workbook and are persisted explicitly so
 * their source remains explainable.
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
  readonly normProfileCode: WorkNormProfileCode;
  /** Official reference travel allowance. Router decides whether to use it or graph travel. */
  readonly normativeTravelDurationSec: number;
  /** Work performed at the customer site, excluding paperwork. */
  readonly technicalDurationSec: number;
  /** Paperwork performed at the customer site. */
  readonly documentationDurationSec: number;
  /** On-site occupancy only: technical plus documentation time, never road time. */
  readonly serviceDurationSec: number;
  readonly priority: Priority;
}

const MINUTES = 60;

export type WorkNormProfileCode =
  | 'connection_base'
  | 'outage_tkd'
  | 'equipment_order'
  | 'local_repair';

export interface WorkNormProfile {
  readonly normProfileCode: WorkNormProfileCode;
  readonly normativeTravelDurationSec: number;
  readonly technicalDurationSec: number;
  readonly documentationDurationSec: number;
  readonly serviceDurationSec: number;
}

/**
 * Canonical work-time norms transcribed from the supplied official workbook.
 *
 * The workbook's road column stays separate from `serviceDurationSec`: Router already
 * schedules travel between points and may use either the graph or the fixed reference
 * allowance. Mixing it into service time would charge every journey twice.
 */
export const WORK_NORM_PROFILES: Readonly<Record<WorkNormProfileCode, WorkNormProfile>> = {
  connection_base: createNormProfile('connection_base', 20, 60, 10),
  outage_tkd: createNormProfile('outage_tkd', 20, 80, 0),
  equipment_order: createNormProfile('equipment_order', 20, 10, 10),
  local_repair: createNormProfile('local_repair', 20, 30, 0),
};

function createNormProfile(
  normProfileCode: WorkNormProfileCode,
  normativeTravelMinutes: number,
  technicalMinutes: number,
  documentationMinutes: number,
): WorkNormProfile {
  return {
    normProfileCode,
    normativeTravelDurationSec: normativeTravelMinutes * MINUTES,
    technicalDurationSec: technicalMinutes * MINUTES,
    documentationDurationSec: documentationMinutes * MINUTES,
    serviceDurationSec: (technicalMinutes + documentationMinutes) * MINUTES,
  };
}

const CONNECTION_BASE = WORK_NORM_PROFILES.connection_base;
const OUTAGE_TKD = WORK_NORM_PROFILES.outage_tkd;
const EQUIPMENT_ORDER = WORK_NORM_PROFILES.equipment_order;
const LOCAL_REPAIR = WORK_NORM_PROFILES.local_repair;

export const WORK_TYPES: readonly WorkTypeSpec[] = [
  // Emergency work: a service already in use has failed.
  {
    code: 'outage',
    title: 'Авария',
    aliases: ['Авария'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'urgent',
  },
  {
    code: 'no_link',
    title: 'Нет линка',
    aliases: ['Нет линка'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'urgent',
  },
  {
    code: 'disconnects',
    title: 'Разрывы',
    aliases: ['Разрывы'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'normal',
  },
  {
    code: 'low_speed',
    title: 'Низкая скорость',
    aliases: ['Низкая скорость'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'normal',
  },
  {
    code: 'port_errors',
    title: 'Рост ошибок на порту',
    aliases: ['Рост ошибок на порту'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'normal',
  },
  {
    code: 'ip_169',
    title: 'IP-адрес 169...',
    aliases: ['IP-адрес 169...'],
    skill: 'emergency',
    ...OUTAGE_TKD,
    priority: 'normal',
  },

  // Connection work and additional orders.
  {
    code: 'connection_request',
    title: 'Заявка на подключение',
    aliases: ['Заявка на подключение'],
    skill: 'connection',
    ...CONNECTION_BASE,
    priority: 'normal',
  },
  {
    code: 'convergence',
    title: 'Конвергенция абонента',
    aliases: ['Конвергенция абонента'],
    skill: 'connection',
    ...CONNECTION_BASE,
    priority: 'normal',
  },
  {
    code: 'equipment_order',
    title: 'Дозаказ оборудования',
    aliases: ['Дозаказ оборудования', 'Заказ подключения/Дозаказ оборудования'],
    skill: 'connection',
    ...EQUIPMENT_ORDER,
    priority: 'normal',
  },
  {
    code: 'router_replacement',
    title: 'Роутер. Замена',
    aliases: ['Роутер. Замена', 'Роутер. Замена техническим специалистом'],
    skill: 'connection',
    ...EQUIPMENT_ORDER,
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
    ...EQUIPMENT_ORDER,
    priority: 'normal',
  },
  {
    code: 'gigabit_switch',
    title: 'Переключение на Гбит/с',
    aliases: ['Переключение на Гбит/с'],
    skill: 'connection',
    ...CONNECTION_BASE,
    priority: 'normal',
  },

  // Local work: performed on site, neither an outage nor a connection.
  {
    code: 'cable_work',
    title: 'Работа с кабелем',
    aliases: ['Работа с кабелем'],
    skill: 'local',
    ...LOCAL_REPAIR,
    priority: 'normal',
  },
  {
    code: 'monitoring',
    title: 'Мониторинг',
    aliases: ['Мониторинг'],
    skill: 'local',
    ...LOCAL_REPAIR,
    priority: 'normal',
  },
  {
    code: 'other_errors',
    title: 'TVE/ENT. Другие ошибки',
    aliases: ['TVE/ENT. Другие ошибки'],
    skill: 'local',
    ...LOCAL_REPAIR,
    priority: 'normal',
  },
  {
    code: 'information',
    title: 'Информация',
    aliases: ['Информация'],
    skill: 'local',
    ...LOCAL_REPAIR,
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

/**
 * A customer window shorter than the work norm cannot host the visit: the solver then
 * reports "no feasible window" even when an idle skilled engineer is on shift.
 * Stretch only the end; the start the dispatcher typed stays the promised arrival.
 */
export function fitWindowToService(
  windowStartAt: number,
  windowEndAt: number,
  serviceDurationSec: number,
): { windowStartAt: number; windowEndAt: number } {
  if (windowEndAt - windowStartAt >= serviceDurationSec) {
    return { windowStartAt, windowEndAt };
  }
  return { windowStartAt, windowEndAt: windowStartAt + serviceDurationSec };
}

/** Collapses whitespace and case so a stray double space does not lose a mapping. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const WORK_TYPE_CODES = WORK_TYPES.map((type) => type.code);
