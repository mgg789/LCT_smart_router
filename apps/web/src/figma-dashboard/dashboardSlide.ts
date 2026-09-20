import type { NavItemId } from './fixtures';

/**
 * Vertical stack of MAIN sidebar tabs, in sidebar order.
 * A single request page sits to the right of this stack (not a tab).
 */
export const STACK_NAV = ['day', 'requests', 'engineers', 'alerts', 'policy', 'chats', 'ai'] as const;

export type StackNavId = (typeof STACK_NAV)[number];

export type StackViewKey = 'main' | 'requests' | 'engineers' | 'alerts' | 'policy';

/**
 * True when the nav item lives in the vertical stack.
 */
export function isStackNav(id: NavItemId): id is StackNavId {
  return STACK_NAV.includes(id);
}

/**
 * Index in the vertical stack, or -1 if unknown.
 */
export function stackNavIndex(id: NavItemId): number {
  return STACK_NAV.indexOf(id as StackNavId);
}

/**
 * Shared pane for stack tabs that render the same body.
 * Day / chats / AI share the day plan; engineers, requests, alerts, policy are unique.
 */
export function stackViewKey(id: NavItemId): StackViewKey {
  if (id === 'requests') return 'requests';
  if (id === 'engineers') return 'engineers';
  if (id === 'alerts') return 'alerts';
  if (id === 'policy') return 'policy';
  return 'main';
}

/**
 * +1 going down the stack, -1 up, 0 same or unknown.
 */
export function stackSlideDir(from: NavItemId, to: NavItemId): -1 | 0 | 1 {
  const start = stackNavIndex(from);
  const end = stackNavIndex(to);
  if (start < 0 || end < 0 || start === end) return 0;
  return end > start ? 1 : -1;
}

/**
 * Incoming pane offset: down enters from below, up from above.
 */
export function stackSlideEnter(dir: number): { y: string } {
  if (dir > 0) return { y: '100%' };
  if (dir < 0) return { y: '-100%' };
  return { y: '0%' };
}

/**
 * Outgoing pane offset: down leaves upward, up leaves downward.
 */
export function stackSlideExit(dir: number): { y: string } {
  if (dir > 0) return { y: '-100%' };
  if (dir < 0) return { y: '100%' };
  return { y: '0%' };
}
