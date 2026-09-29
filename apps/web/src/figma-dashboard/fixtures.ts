import type { HandoffView } from '../api/live';
import { t } from '../i18n';

/**
 * Demo snapshot for the static Figma MAIN page.
 * Shaped like future dispatch API payloads so the UI can be exercised without a backend.
 */

export const FIGMA_ARTBOARD = { width: 1920, height: 1080 } as const;

export const POLICY_OPTIONS = [
  t('figma-dashboard.fixtures.568e623109'),
  t('figma-dashboard.fixtures.107a45fc89'),
  t('figma-dashboard.fixtures.e5d759f5a5'),
  t('figma-dashboard.fixtures.94b4982ffa'),
  t('figma-dashboard.fixtures.25907df14d'),
  t('figma-dashboard.fixtures.fbd36f8a94'),
] as const;

export type PolicyOption = (typeof POLICY_OPTIONS)[number];

export type ReasonIconKey = 'reasonCheck' | 'reasonCar' | 'reasonClock' | 'reasonPin';

export type RouteStop = {
  time: string;
  place: string;
  status: string;
  requestId?: string | null;
  kind?: 'start' | 'job' | 'lunch' | 'technical' | 'handoff' | 'delivery' | 'office_pickup';
  handoffId?: string;
  handoff?: HandoffView;
  at?: number;
  active?: boolean;
  failed?: boolean;
  completed?: boolean;
};

export type EngineerRequest = {
  number: string;
  title: string;
  tags: string[];
  company: string;
  address: string;
  window: string;
  work: string;
  whyTitle: string;
  reasons: { icon: ReasonIconKey; label: string }[];
};

export type EngineerCard = {
  lineLabel?: string;
  lineFailed?: boolean;
  id: string;
  name: string;
  km: number;
  /** Raw transport code, independent of the displayed status text. */
  transportType?: string;
  status: string;
  shift: string;
  requestCount: number;
  doneCount: number;
  routeUpdated: string;
  stops: RouteStop[];
  request: EngineerRequest;
  /** First assigned request, when the snapshot has one. */
  primaryRequestId?: string;
};

export type NotificationTone = 'gray' | 'yellow';

export type NotificationIconKey = 'delay' | 'route' | 'message';

export type DashboardNotification = {
  id: string;
  tone: 'yellow' | 'plain';
  icon: NotificationIconKey;
  text: string;
};

/**
 * Keeps at most three notifications for the header dropdown.
 */
export function visibleNotifications(
  items: readonly DashboardNotification[],
): DashboardNotification[] {
  return items.slice(0, 3);
}

/**
 * Formats a notification count as a single-line badge label.
 */
export function formatNotificationCount(count: number): string {
  if (count > 99) return '99+';
  return String(Math.max(0, Math.floor(count)));
}

/**
 * Completed route stops are shown as a green uppercase label.
 */
export function isCompletedStop(status: string): boolean {
  return status.trim().toLocaleLowerCase('ru').startsWith(t('figma-dashboard.fixtures.812d91049d'));
}

/**
 * Display label for a route-stop status chip.
 */
export function routeStopStatusLabel(status: string): string {
  return isCompletedStop(status) ? t('figma-dashboard.fixtures.2d32ba060c') : status;
}

/**
 * Compact card names sit next to «N км»; longer labels are cut at the end.
 * 16 glyphs leave room for a 3-digit kilometre suffix at 20px Murs Gothic.
 */
export const ENGINEER_NAME_MAX = 16;

/**
 * Truncates a display name at the end so it cannot paint over a trailing metric.
 *
 * @param value - Engineer, brigade, or other roster label
 * @param max - Inclusive glyph budget before the ellipsis
 */
export function truncateEnd(value: string, max = ENGINEER_NAME_MAX): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Filters engineers by a case-insensitive name query.
 */
export function filterEngineers(engineers: readonly EngineerCard[], query: string): EngineerCard[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return [...engineers];
  return engineers.filter((engineer) => engineer.name.toLocaleLowerCase('ru').includes(needle));
}

export const MAIN_DASHBOARD = {
  dateLabel: t('figma-dashboard.fixtures.27efea7717'),
  defaultPolicy: t('figma-dashboard.fixtures.568e623109') satisfies PolicyOption,
  notification: { count: 12, tone: 'yellow' as NotificationTone },
  notifications: [
    {
      id: 'delay',
      tone: 'yellow',
      icon: 'delay',
      text: t('figma-dashboard.fixtures.797981e971'),
    },
    {
      id: 'graph',
      tone: 'plain',
      icon: 'route',
      text: t('figma-dashboard.fixtures.f95077a1b3'),
    },
    {
      id: 'message',
      tone: 'plain',
      icon: 'message',
      text: t('figma-dashboard.fixtures.e95971b353'),
    },
  ] satisfies DashboardNotification[],
  unassigned: {
    title: t('figma-dashboard.fixtures.b06fd906e7'),
    reason: t('figma-dashboard.fixtures.f73f5b0b79'),
  },
  engineers: [
    {
      id: 'sokolov',
      name: t('figma-dashboard.fixtures.05f56c34dd'),
      km: 28,
      status: t('figma-dashboard.fixtures.cdd22f9fd0'),
      shift: '8:00-17:00',
      requestCount: 6,
      doneCount: 2,
      routeUpdated: t('figma-dashboard.fixtures.bf673f1789'),
      stops: [
        {
          time: '9:10',
          place: t('figma-dashboard.fixtures.cf9424ded9'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '10:13',
          place: t('figma-dashboard.fixtures.f77e69a641'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '12:20',
          place: t('figma-dashboard.fixtures.2f85fa85d8'),
          status: t('figma-dashboard.fixtures.d42555c45c'),
        },
        {
          time: '14:05',
          place: t('figma-dashboard.fixtures.198f44de8f'),
          status: t('figma-dashboard.fixtures.af3f744cc7'),
        },
        {
          time: '15:40',
          place: t('figma-dashboard.fixtures.ae810c41d9'),
          status: t('figma-dashboard.fixtures.1e54a5cd3c'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.ed828286db'),
        title: t('figma-dashboard.fixtures.267805bd26'),
        tags: [t('figma-dashboard.fixtures.eb9b40bded'), t('figma-dashboard.fixtures.5a2595c21f')],
        company: t('figma-dashboard.fixtures.262e8dbb00'),
        address: t('figma-dashboard.fixtures.d0ddab524d'),
        window: '12:00-14:00',
        work: t('figma-dashboard.fixtures.9fa84e238b'),
        whyTitle: t('figma-dashboard.fixtures.1009f9f1a2'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.3911162cca') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.6de3fff645') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.3791d1b8d0') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.4e45b42fb4') },
        ],
      },
    },
    {
      id: 'volkova',
      name: t('figma-dashboard.fixtures.72fcbc1272'),
      km: 41,
      status: t('figma-dashboard.fixtures.cdd22f9fd0'),
      shift: '8:00-17:00',
      requestCount: 5,
      doneCount: 4,
      routeUpdated: t('figma-dashboard.fixtures.37e26432fa'),
      stops: [
        {
          time: '8:40',
          place: t('figma-dashboard.fixtures.3fc415e438'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '10:05',
          place: t('figma-dashboard.fixtures.289e6ad49b'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '13:10',
          place: t('figma-dashboard.fixtures.8a4a9aa276'),
          status: t('figma-dashboard.fixtures.757e10e159'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.2f11c66738'),
        title: t('figma-dashboard.fixtures.8c74245a48'),
        tags: [t('figma-dashboard.fixtures.0e5ac36d3f'), 'B2B'],
        company: t('figma-dashboard.fixtures.86229f1eea'),
        address: t('figma-dashboard.fixtures.ffd8998619'),
        window: '12:30-15:00',
        work: t('figma-dashboard.fixtures.1e287f6ebe'),
        whyTitle: t('figma-dashboard.fixtures.d977158bb1'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.9dc1f954b9') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.4e2b40dcc9') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.ecf9bd2f0f') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.588fce2ca8') },
        ],
      },
    },
    {
      id: 'alexandrov',
      name: t('figma-dashboard.fixtures.9d9729f6de'),
      km: 19,
      status: t('figma-dashboard.fixtures.7376f1d753'),
      shift: '9:00-18:00',
      requestCount: 4,
      doneCount: 1,
      routeUpdated: t('figma-dashboard.fixtures.1b90cececc'),
      stops: [
        {
          time: '9:20',
          place: t('figma-dashboard.fixtures.12006cfbea'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '11:00',
          place: t('figma-dashboard.fixtures.57b9265389'),
          status: t('figma-dashboard.fixtures.28c96d4c70'),
        },
        {
          time: '13:15',
          place: t('figma-dashboard.fixtures.ea28d2c630'),
          status: t('figma-dashboard.fixtures.257bf72641'),
        },
        {
          time: '16:00',
          place: t('figma-dashboard.fixtures.3e839e7569'),
          status: t('figma-dashboard.fixtures.0387093b98'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.1376c7585b'),
        title: t('figma-dashboard.fixtures.0a163c10a2'),
        tags: [t('figma-dashboard.fixtures.eb9b40bded'), t('figma-dashboard.fixtures.7f1b1af539')],
        company: t('figma-dashboard.fixtures.f5a9fbcee1'),
        address: t('figma-dashboard.fixtures.c7401ea10f'),
        window: '10:30-12:30',
        work: t('figma-dashboard.fixtures.cfd06ffab5'),
        whyTitle: t('figma-dashboard.fixtures.37164c4bbc'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.874f6c480e') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.cfef432e68') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.6b546e4a01') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.74cd424192') },
        ],
      },
    },
    {
      id: 'petrov',
      name: t('figma-dashboard.fixtures.2b8929bad3'),
      km: 33,
      status: t('figma-dashboard.fixtures.2bc104c54f'),
      shift: '8:00-17:00',
      requestCount: 3,
      doneCount: 2,
      routeUpdated: t('figma-dashboard.fixtures.4c0bd11566'),
      stops: [
        {
          time: '9:00',
          place: t('figma-dashboard.fixtures.4746abc9f8'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '11:45',
          place: t('figma-dashboard.fixtures.ed982088cf'),
          status: t('figma-dashboard.fixtures.5af8d4216d'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.e52affb7ae'),
        title: t('figma-dashboard.fixtures.57f720425a'),
        tags: [t('figma-dashboard.fixtures.fd207fae5b'), 'B2B'],
        company: t('figma-dashboard.fixtures.cfab46f34a'),
        address: t('figma-dashboard.fixtures.af2b622d34'),
        window: '11:00-13:00',
        work: t('figma-dashboard.fixtures.aa9b8f796e'),
        whyTitle: t('figma-dashboard.fixtures.127c96ec0d'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.59f49a3f0e') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.79c07b6587') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.4a202897be') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.b9cd68ba68') },
        ],
      },
    },
    {
      id: 'kuznetsova',
      name: t('figma-dashboard.fixtures.6d9e6db129'),
      km: 12,
      status: t('figma-dashboard.fixtures.1f1b80ad28'),
      shift: '10:00-19:00',
      requestCount: 3,
      doneCount: 0,
      routeUpdated: t('figma-dashboard.fixtures.e3c7bcfc77'),
      stops: [
        {
          time: '14:10',
          place: t('figma-dashboard.fixtures.b11ff90a82'),
          status: t('figma-dashboard.fixtures.e9dcd556d0'),
        },
        {
          time: '16:00',
          place: t('figma-dashboard.fixtures.77431baba0'),
          status: t('figma-dashboard.fixtures.97039a8781'),
        },
        {
          time: '17:40',
          place: t('figma-dashboard.fixtures.4322a4d715'),
          status: t('figma-dashboard.fixtures.84b5d8f644'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.e8eafd8725'),
        title: t('figma-dashboard.fixtures.409005d2f5'),
        tags: [t('figma-dashboard.fixtures.5a2595c21f'), t('figma-dashboard.fixtures.eb9b40bded')],
        company: t('figma-dashboard.fixtures.1db10de086'),
        address: t('figma-dashboard.fixtures.08904be7aa'),
        window: '14:00-16:00',
        work: t('figma-dashboard.fixtures.5a1c80a2ac'),
        whyTitle: t('figma-dashboard.fixtures.18e2194ab1'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.9269dcc0f1') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.0c27e2ced9') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.dc1e86e832') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.677feec0b9') },
        ],
      },
    },
    {
      id: 'orlov',
      name: t('figma-dashboard.fixtures.2a9b32d20b'),
      km: 52,
      status: t('figma-dashboard.fixtures.cdd22f9fd0'),
      shift: '8:00-20:00',
      requestCount: 8,
      doneCount: 5,
      routeUpdated: t('figma-dashboard.fixtures.7c441c793f'),
      stops: [
        {
          time: '8:20',
          place: t('figma-dashboard.fixtures.66dc57fd71'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '9:50',
          place: t('figma-dashboard.fixtures.10cd2670b6'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '11:30',
          place: t('figma-dashboard.fixtures.20a1f96083'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '13:10',
          place: t('figma-dashboard.fixtures.ef269b6706'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
        {
          time: '15:00',
          place: t('figma-dashboard.fixtures.69ae587901'),
          status: t('figma-dashboard.fixtures.48de9b3680'),
        },
        {
          time: '17:20',
          place: t('figma-dashboard.fixtures.431c48a303'),
          status: t('figma-dashboard.fixtures.84b5d8f644'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.e5ea19e816'),
        title: t('figma-dashboard.fixtures.a714f3161e'),
        tags: [t('figma-dashboard.fixtures.f2fffe5fe5'), t('figma-dashboard.fixtures.0e5ac36d3f')],
        company: t('figma-dashboard.fixtures.e243c08379'),
        address: t('figma-dashboard.fixtures.3af3524144'),
        window: '14:30-16:30',
        work: t('figma-dashboard.fixtures.e5d50ceae9'),
        whyTitle: t('figma-dashboard.fixtures.493cc0262e'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.6bc00f2bcd') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.59b255bebe') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.4680fd0b05') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.7a6045d6c3') },
        ],
      },
    },
    {
      id: 'belova',
      name: t('figma-dashboard.fixtures.ed2d91ea6e'),
      km: 7,
      status: t('figma-dashboard.fixtures.8e8399b5f8'),
      shift: '8:00-16:00',
      requestCount: 2,
      doneCount: 2,
      routeUpdated: t('figma-dashboard.fixtures.f2124dc63f'),
      stops: [
        {
          time: '10:30',
          place: t('figma-dashboard.fixtures.a22b8481d0'),
          status: t('figma-dashboard.fixtures.f40eba382c'),
        },
      ],
      request: {
        number: t('figma-dashboard.fixtures.1b7f620d01'),
        title: t('figma-dashboard.fixtures.e4cfe059e3'),
        tags: [t('figma-dashboard.fixtures.095f8a67b5'), 'B2B'],
        company: t('figma-dashboard.fixtures.96aaef6bb1'),
        address: t('figma-dashboard.fixtures.194edcd93f'),
        window: '10:00-12:00',
        work: t('figma-dashboard.fixtures.1ebdae5d23'),
        whyTitle: t('figma-dashboard.fixtures.dd0b914736'),
        reasons: [
          { icon: 'reasonCheck', label: t('figma-dashboard.fixtures.9aa9b831b1') },
          { icon: 'reasonCar', label: t('figma-dashboard.fixtures.6fd618e47b') },
          { icon: 'reasonClock', label: t('figma-dashboard.fixtures.4253f5a8a4') },
          { icon: 'reasonPin', label: t('figma-dashboard.fixtures.b2b7bd57af') },
        ],
      },
    },
  ] satisfies EngineerCard[],
} as const;

export const MAIN_REQUEST_COUNT =
  MAIN_DASHBOARD.engineers.reduce((sum, engineer) => sum + engineer.requestCount, 0) + 2;

/**
 * Russian plural for the day request counter.
 */
export function requestCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11)
    return t('figma-dashboard.fixtures.d2d24b3a70', { value0: count });
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return t('figma-dashboard.fixtures.93af52f7e4', { value0: count });
  return t('figma-dashboard.fixtures.1a0d7eaf92', { value0: count });
}
