/** Every route of the dispatcher app in one place. */
export const ROUTES = {
  login: '/login',
  plan: '/',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];
