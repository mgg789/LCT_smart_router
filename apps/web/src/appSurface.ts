/** Which SPA shell the current path should mount. */
export type AppSurface = 'client' | 'engineer' | 'dispatcher';

/**
 * Splits `/client`, `/engineer` and the dispatcher dashboard.
 * Trailing slashes and nested paths stay on the same surface.
 */
export function appSurface(pathname: string): AppSurface {
  if (pathname === '/client' || pathname.startsWith('/client/')) return 'client';
  if (pathname === '/engineer' || pathname.startsWith('/engineer/')) return 'engineer';
  return 'dispatcher';
}
