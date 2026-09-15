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
 */
export interface WorkTypeSpec {
  readonly code: string;
  /** As it appears in the dataset and in the client-facing list. */
  readonly title: string;
  readonly skill: Skill;
  readonly serviceDurationSec: number;
  readonly priority: Priority;
}

const MINUTES = 60;

export const WORK_TYPES: readonly WorkTypeSpec[] = [
  // Emergency work: a failure of a service already in use.
  {
    code: 'outage',
    title: 'Авария',
    skill: 'emergency',
    serviceDurationSec: 90 * MINUTES,
    priority: 'urgent',
  },
  {
    code: 'no_link',
    title: 'Нет линка',
    skill: 'emergency',
    serviceDurationSec: 90 * MINUTES,
    priority: 'urgent',
  },
  {
    code: 'disconnects',
    title: 'Разрывы',
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'low_speed',
    title: 'Низкая скорость',
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'port_errors',
    title: 'Рост ошибок на порту',
    skill: 'emergency',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },

  // Connection work and additional orders.
  {
    code: 'connection_request',
    title: 'Заявка на подключение',
    skill: 'connection',
    serviceDurationSec: 75 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'convergence',
    title: 'Конвергенция абонента',
    skill: 'connection',
    serviceDurationSec: 50 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'equipment_order',
    title: 'Дозаказ оборудования',
    skill: 'connection',
    serviceDurationSec: 45 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'router_replacement',
    title: 'Роутер. Замена',
    skill: 'connection',
    serviceDurationSec: 35 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'stb_replacement',
    title: 'ТВ/TVE/ENT. Замена приставки',
    skill: 'connection',
    serviceDurationSec: 35 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'gigabit_switch',
    title: 'Переключение на Гбит/с',
    skill: 'connection',
    serviceDurationSec: 45 * MINUTES,
    priority: 'normal',
  },

  // Local work: everything performed on site that is neither an outage nor a connection.
  {
    code: 'cable_work',
    title: 'Работа с кабелем',
    skill: 'local',
    serviceDurationSec: 60 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'monitoring',
    title: 'Мониторинг',
    skill: 'local',
    serviceDurationSec: 30 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'other_errors',
    title: 'TVE/ENT. Другие ошибки',
    skill: 'local',
    serviceDurationSec: 40 * MINUTES,
    priority: 'normal',
  },
  {
    code: 'information',
    title: 'Информация',
    skill: 'local',
    serviceDurationSec: 30 * MINUTES,
    priority: 'normal',
  },
] as const;

const BY_CODE = new Map(WORK_TYPES.map((type) => [type.code, type]));

export function findWorkType(code: string): WorkTypeSpec | undefined {
  return BY_CODE.get(code);
}

export const WORK_TYPE_CODES = WORK_TYPES.map((type) => type.code);
