import type { LiveRouteProgress } from '../api/live';
import type { RouteStop } from './fixtures';

/** Position of the factual LIVE cursor between two visible plan points. */
export function routeProgressMarker(
  stops: readonly RouteStop[],
  progress: LiveRouteProgress | null,
): { readonly fromIndex: number; readonly toIndex: number; readonly progress: number } | null {
  if (progress?.phase !== 'traveling' || !progress.next) return null;
  const path = progress.lunch
    ? progress.occurredAt < progress.lunch.at
      ? [progress.anchor, progress.lunch]
      : [progress.lunch, progress.next]
    : [progress.anchor, progress.next];
  const [from, to] = path;
  if (!from || !to) return null;
  const matches = (stop: RouteStop, point: LiveRouteProgress['anchor']) =>
    point.kind === 'job' ? stop.requestId === point.requestId : stop.kind === point.kind;
  const fromIndex = stops.findIndex((stop) => matches(stop, from));
  const toIndex = stops.findIndex((stop) => matches(stop, to));
  if (fromIndex < 0 || toIndex <= fromIndex) return null;
  const span = Math.max(1, to.at - from.at);
  const ratio = Math.min(1, Math.max(0, (progress.occurredAt - from.at) / span));
  return { fromIndex, toIndex, progress: ratio * (toIndex - fromIndex) };
}
