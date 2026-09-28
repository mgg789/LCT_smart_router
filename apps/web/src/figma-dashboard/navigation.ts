import { t } from '../i18n';

/** Navigation available in the dispatcher sidebar, independent of demo fixtures. */
export const NAV_ITEMS = [
  { id: 'day', label: t('figma-dashboard.fixtures.255f2a4738'), icon: 'navHome' },
  { id: 'requests', label: t('figma-dashboard.fixtures.e0e664b5a8'), icon: 'navRequests' },
  { id: 'engineers', label: t('figma-dashboard.fixtures.960ef88466'), icon: 'navEngineers' },
  { id: 'alerts', label: t('figma-dashboard.fixtures.6e67d08041'), icon: 'navAlerts' },
  { id: 'policy', label: t('figma-dashboard.fixtures.fdac00bd6e'), icon: 'navPolicy' },
  { id: 'chats', label: t('figma-dashboard.fixtures.b5121e526d'), icon: 'navChats' },
  { id: 'ai', label: t('figma-dashboard.fixtures.11fb682be0'), icon: 'navAi' },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]['id'];
