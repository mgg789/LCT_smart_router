/** Every route of the dispatcher app in one place. */
export const ROUTES = {
  login: '/login',
  plan: '/plan',
  requests: '/requests',
  engineers: '/engineers',
  alerts: '/alerts',
  policy: '/policy',
  chats: '/chats',
  ai: '/ai',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];
