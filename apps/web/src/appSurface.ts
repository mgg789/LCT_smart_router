import { t } from './i18n';
/** Which SPA shell the current path should mount. */
export type AppSurface = 'client' | 'engineer' | 'dispatcher';

/** Browser-tab title for each independently exposed application surface. */
export function appSurfaceTitle(surface: AppSurface): string {
  if (surface === 'client') return t('appSurface.661a8e3178');
  if (surface === 'engineer') return t('appSurface.487584c44e');
  return t('appSurface.1000963ec9');
}

/**
 * Splits `/client`, `/engineer` and the dispatcher dashboard.
 * Trailing slashes and nested paths stay on the same surface.
 */
export function appSurface(pathname: string): AppSurface {
  if (pathname === '/client' || pathname.startsWith('/client/')) return 'client';
  if (pathname === '/engineer' || pathname.startsWith('/engineer/')) return 'engineer';
  return 'dispatcher';
}
