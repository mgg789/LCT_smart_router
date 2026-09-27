import type { Map as MapLibreMap } from 'maplibre-gl';

declare global {
  interface Window {
    /** Set by the launcher before the app boots; never cleared by browser events. */
    navixOffline?: boolean;
  }
}

/** Shared street basemap for dispatcher and engineer views. */
export const ONLINE_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const STARTUP_GRACE_MS = 15_000;

/** Returns true only when the browser and launcher both permit network maps. */
export function browserMapOnline(): boolean {
  return mapNetworkAllowed(
    typeof window !== 'undefined' && window.navixOffline === true,
    typeof navigator !== 'undefined' && navigator.onLine,
  );
}

/** Pure policy helper kept separate so offline startup is testable without a DOM. */
export function mapNetworkAllowed(launcherOffline: boolean, browserOnline: boolean): boolean {
  return !launcherOffline && browserOnline;
}

/** True when the launcher deliberately selected the local-only contour. */
export function isNavixOffline(): boolean {
  return typeof window !== 'undefined' && window.navixOffline === true;
}

/** Fall back only when startup never rendered, not after an isolated tile error. */
export function needsStartupFallback(rendered: boolean, elapsedMs: number): boolean {
  return !rendered && elapsedMs >= STARTUP_GRACE_MS;
}

/** Watches initial map availability; returns cleanup for the owning React effect. */
export function watchMapStartup(map: MapLibreMap, fallback: () => void): () => void {
  let rendered = false;
  const ready = () => {
    rendered = true;
  };
  map.on('idle', ready);
  const timeout = window.setTimeout(() => {
    if (needsStartupFallback(rendered, STARTUP_GRACE_MS)) fallback();
  }, STARTUP_GRACE_MS);
  return () => {
    window.clearTimeout(timeout);
    map.off('idle', ready);
  };
}
