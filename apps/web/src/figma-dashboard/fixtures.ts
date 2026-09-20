/**
 * Demo snapshot for the static Figma MAIN page.
 * Shaped like future dispatch API payloads so the UI can be exercised without a backend.
 */

export const FIGMA_ARTBOARD = { width: 1920, height: 1080 } as const;

export const POLICY_OPTIONS = [
  'Быстрее',
  'Меньше инженеров',
  'Бережнее к окнам',
  'Ровнее загрузка',
  'Короче пробег',
  'Базовая из ТЗ',
] as const;

export type PolicyOption = (typeof POLICY_OPTIONS)[number];

export const NAV_ITEMS = [
  { id: 'day', label: 'План дня', icon: 'navHome' },
  { id: 'requests', label: 'Заявки', icon: 'navRequests' },
  { id: 'engineers', label: 'Инженеры', icon: 'navEngineers' },
  { id: 'alerts', label: 'Алерты', icon: 'navAlerts' },
  { id: 'policy', label: 'Политики', icon: 'navPolicy' },
  { id: 'chats', label: 'Чаты', icon: 'navChats' },
  { id: 'ai', label: 'AI', icon: 'navAi' },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]['id'];

export type ReasonIconKey = 'reasonCheck' | 'reasonCar' | 'reasonClock' | 'reasonPin';

export type RouteStop = {
  time: string;
  place: string;
  status: string;
  requestId?: string | null;
  kind?: 'start' | 'job' | 'lunch' | 'technical';
  at?: number;
  active?: boolean;
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
  id: string;
  name: string;
  km: number;
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
  return status.trim().toLocaleLowerCase('ru').startsWith('выполнен');
}

/**
 * Display label for a route-stop status chip.
 */
export function routeStopStatusLabel(status: string): string {
  return isCompletedStop(status) ? 'ВЫПОЛНЕНО' : status;
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
  dateLabel: '15 сентября, 2026',
  defaultPolicy: 'Быстрее' satisfies PolicyOption,
  notification: { count: 12, tone: 'yellow' as NotificationTone },
  notifications: [
    {
      id: 'delay',
      tone: 'yellow',
      icon: 'delay',
      text: 'Сильное опоздание у Алексея Соколова',
    },
    {
      id: 'graph',
      tone: 'plain',
      icon: 'route',
      text: 'Граф перестроен из-за новой политики',
    },
    {
      id: 'message',
      tone: 'plain',
      icon: 'message',
      text: 'Новое сообщение от Елены Волковой',
    },
  ] satisfies DashboardNotification[],
  unassigned: {
    title: '2 заявки без назначения',
    reason: 'Нет инженера с нужным навыком',
  },
  engineers: [
    {
      id: 'sokolov',
      name: 'Алексей Соколов',
      km: 28,
      status: 'в работе',
      shift: '8:00-17:00',
      requestCount: 6,
      doneCount: 2,
      routeUpdated: 'план обновлён в 11:42 ',
      stops: [
        { time: '9:10', place: 'Офис - ул. Лесная, 7', status: 'выполнено' },
        { time: '10:13', place: 'Магазин - ул. Покровка, 11', status: 'выполнено' },
        {
          time: '12:20',
          place: 'Подключение офиса - Таганская, 24',
          status: 'сейчас - визит 45 мин',
        },
        { time: '14:05', place: 'Роутер - Садовая, 3', status: 'в пути 18 мин' },
        { time: '15:40', place: 'Диагностика - Арбат, 16', status: 'окно 15:30-17:00' },
      ],
      request: {
        number: 'Заявка № 1042',
        title: 'Подключение офиса',
        tags: ['Интернет', 'Новый клиент'],
        company: 'ООО “Горизонт”',
        address: 'Таганская, 24',
        window: '12:00-14:00',
        work: 'Подключение интернета',
        whyTitle: 'Почему Алексей?',
        reasons: [
          { icon: 'reasonCheck', label: 'Подходит навык' },
          { icon: 'reasonCar', label: 'Есть требуемый автомобиль (до 3.5 т)' },
          { icon: 'reasonClock', label: 'Начало внутри окна' },
          { icon: 'reasonPin', label: 'От предыдущей точки ехать 12 мин' },
        ],
      },
    },
    {
      id: 'volkova',
      name: 'Елена Волкова',
      km: 41,
      status: 'в работе',
      shift: '8:00-17:00',
      requestCount: 5,
      doneCount: 4,
      routeUpdated: 'план обновлён в 12:08',
      stops: [
        { time: '8:40', place: 'Абонент - Тверская, 9', status: 'выполнено' },
        { time: '10:05', place: 'Офис - Мясницкая, 15', status: 'выполнено' },
        { time: '13:10', place: 'Авария - Сретенка, 4', status: 'сейчас - визит 30 мин' },
      ],
      request: {
        number: 'Заявка № 1108',
        title: 'Авария на узле',
        tags: ['Приоритет', 'B2B'],
        company: 'АО “Север”',
        address: 'Сретенка, 4',
        window: '12:30-15:00',
        work: 'Восстановление канала',
        whyTitle: 'Почему Елена?',
        reasons: [
          { icon: 'reasonCheck', label: 'Есть навык аварий' },
          { icon: 'reasonCar', label: 'Легковой автомобиль' },
          { icon: 'reasonClock', label: 'Успевает в окно SLA' },
          { icon: 'reasonPin', label: 'Ближе всех к узлу' },
        ],
      },
    },
    {
      id: 'alexandrov',
      name: 'Никита Александров',
      km: 19,
      status: 'в пути',
      shift: '9:00-18:00',
      requestCount: 4,
      doneCount: 1,
      routeUpdated: 'план обновлён в 10:21',
      stops: [
        { time: '9:20', place: 'Склад - Каширская, 8', status: 'выполнено' },
        { time: '11:00', place: 'Магазин - Ордынка, 21', status: 'в пути 14 мин' },
        { time: '13:15', place: 'Офис - Пятницкая, 6', status: 'окно 13:00-15:00' },
        { time: '16:00', place: 'Клиент - Якиманка, 2', status: 'окно 15:30-18:00' },
      ],
      request: {
        number: 'Заявка № 1184',
        title: 'Замена ONU',
        tags: ['Интернет', 'Оборудование'],
        company: 'ИП Морозов',
        address: 'Ордынка, 21',
        window: '10:30-12:30',
        work: 'Замена терминала',
        whyTitle: 'Почему Никита?',
        reasons: [
          { icon: 'reasonCheck', label: 'Нужный навык и запчасть' },
          { icon: 'reasonCar', label: 'Есть место под оборудование' },
          { icon: 'reasonClock', label: 'Старт внутри окна' },
          { icon: 'reasonPin', label: 'От склада 14 мин' },
        ],
      },
    },
    {
      id: 'petrov',
      name: 'Иван Петров',
      km: 33,
      status: 'на объекте',
      shift: '8:00-17:00',
      requestCount: 3,
      doneCount: 2,
      routeUpdated: 'план обновлён в 09:55',
      stops: [
        { time: '9:00', place: 'БЦ - Павелецкая, 12', status: 'выполнено' },
        { time: '11:45', place: 'Склад - Дубровка, 5', status: 'сейчас - визит 20 мин' },
      ],
      request: {
        number: 'Заявка № 1211',
        title: 'Выдача комплекта',
        tags: ['Склад', 'B2B'],
        company: 'ООО “Лента”',
        address: 'Дубровка, 5',
        window: '11:00-13:00',
        work: 'Получение оборудования',
        whyTitle: 'Почему Иван?',
        reasons: [
          { icon: 'reasonCheck', label: 'Доступ на склад' },
          { icon: 'reasonCar', label: 'Фургон до 3.5 т' },
          { icon: 'reasonClock', label: 'Попадает в окно склада' },
          { icon: 'reasonPin', label: 'Уже был рядом после БЦ' },
        ],
      },
    },
    {
      id: 'kuznetsova',
      name: 'Мария Кузнецова',
      km: 12,
      status: 'свободна',
      shift: '10:00-19:00',
      requestCount: 3,
      doneCount: 0,
      routeUpdated: 'план обновлён в 13:02',
      stops: [
        { time: '14:10', place: 'Клиент - Покровка, 8', status: 'ближайшая' },
        { time: '16:00', place: 'Офис - Маросейка, 3', status: 'окно 15:30-17:30' },
        { time: '17:40', place: 'Абонент - Солянка, 14', status: 'окно 17:00-19:00' },
      ],
      request: {
        number: 'Заявка № 1302',
        title: 'Настройка Wi-Fi',
        tags: ['Новый клиент', 'Интернет'],
        company: 'Кафе “Зерно”',
        address: 'Покровка, 8',
        window: '14:00-16:00',
        work: 'Настройка сети',
        whyTitle: 'Почему Мария?',
        reasons: [
          { icon: 'reasonCheck', label: 'Навык абонентских работ' },
          { icon: 'reasonCar', label: 'Легковой, парковка у двора' },
          { icon: 'reasonClock', label: 'Смена с 10:00' },
          { icon: 'reasonPin', label: '12 минут от базы' },
        ],
      },
    },
    {
      id: 'orlov',
      name: 'Дмитрий Орлов',
      km: 52,
      status: 'в работе',
      shift: '8:00-20:00',
      requestCount: 8,
      doneCount: 5,
      routeUpdated: 'план обновлён в 14:17',
      stops: [
        { time: '8:20', place: 'База - Варшавка, 18', status: 'выполнено' },
        { time: '9:50', place: 'ТЦ - Калужская, 1', status: 'выполнено' },
        { time: '11:30', place: 'Офис - Ленинский, 45', status: 'выполнено' },
        { time: '13:10', place: 'Клиент - Профсоюзная, 78', status: 'выполнено' },
        { time: '15:00', place: 'Узел - Новые Черёмушки', status: 'сейчас - визит 50 мин' },
        { time: '17:20', place: 'Авария - Юго-Западная', status: 'окно 17:00-19:00' },
      ],
      request: {
        number: 'Заявка № 1420',
        title: 'Расширение узла',
        tags: ['Магистраль', 'Приоритет'],
        company: 'ПАО “Связь”',
        address: 'Новые Черёмушки',
        window: '14:30-16:30',
        work: 'Монтаж кросса',
        whyTitle: 'Почему Дмитрий?',
        reasons: [
          { icon: 'reasonCheck', label: 'Допуск на узел' },
          { icon: 'reasonCar', label: 'Есть грузовик до 3.5 т' },
          { icon: 'reasonClock', label: 'Длинная смена до 20:00' },
          { icon: 'reasonPin', label: 'Уже в районе Черёмушек' },
        ],
      },
    },
    {
      id: 'belova',
      name: 'Ольга Белова',
      km: 7,
      status: 'завершила',
      shift: '8:00-16:00',
      requestCount: 2,
      doneCount: 2,
      routeUpdated: 'план обновлён в 11:05',
      stops: [{ time: '10:30', place: 'Офис - Кузнецкий Мост, 7', status: 'выполнено' }],
      request: {
        number: 'Заявка № 1007',
        title: 'Снятие показаний',
        tags: ['Сервис', 'B2B'],
        company: 'ООО “Атлас”',
        address: 'Кузнецкий Мост, 7',
        window: '10:00-12:00',
        work: 'Сервисное обслуживание',
        whyTitle: 'Почему Ольга?',
        reasons: [
          { icon: 'reasonCheck', label: 'Короткий сервисный навык' },
          { icon: 'reasonCar', label: 'Пешая зона, авто не нужен' },
          { icon: 'reasonClock', label: 'Попала в начало окна' },
          { icon: 'reasonPin', label: '7 км суммарно за день' },
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
  if (mod10 === 1 && mod100 !== 11) return `${count} заявка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} заявки`;
  return `${count} заявок`;
}
