/**
 * Static copy from Figma MAIN (28:614) and the open-policy frame (29:2552).
 * First-pass dashboard is visual-only: no dispatch API.
 */

export const FIGMA_ARTBOARD = { width: 1920, height: 1080 } as const;

export const POLICY_OPTIONS = [
  'Быстрее до клиента',
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
  { id: 'policy', label: 'Политика', icon: 'navPolicy' },
  { id: 'chats', label: 'Чаты', icon: 'navChats' },
  { id: 'ai', label: 'AI', icon: 'navAi' },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]['id'];

export type EngineerCard = {
  id: string;
  name: string;
  selected: boolean;
  progressPx: number;
};

export const MAIN_DASHBOARD = {
  dateLabel: '15 сентября, 2026',
  requestCountLabel: '24 заявки',
  planSummary: '2 без назначения - план от 11:42',
  engineerCount: 4,
  defaultPolicy: 'Быстрее до клиента' satisfies PolicyOption,
  notificationCount: 12,
  engineers: [
    { id: 'sokolov', name: 'Алексей Соколов', selected: true, progressPx: 107 },
    { id: 'volkova', name: 'Елена Волкова', selected: false, progressPx: 267.5 },
    { id: 'alexa', name: 'Никита Алекса...', selected: false, progressPx: 53.5 },
    { id: 'petrovich', name: 'Иван Петрович', selected: false, progressPx: 214 },
  ] satisfies EngineerCard[],
  unassigned: {
    title: '2 заявки без назначения',
    reason: 'Нет инженера с нужным навыком',
  },
  route: {
    title: 'Маршрут Алексея Соколова',
    updated: 'план обновлён в 11:42 ',
    stops: [
      { time: '9:10', place: 'Офис - ул. Лесная, 7', status: 'выполнено' },
      { time: '10:13', place: 'Магазин - ул. Покровка, 11', status: 'выполнено' },
      { time: '12:20', place: 'Подключение офиса - Таганская, 24', status: 'сейчас - визит 45 мин' },
    ],
  },
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
} as const;

export type ReasonIconKey = (typeof MAIN_DASHBOARD.request.reasons)[number]['icon'];
