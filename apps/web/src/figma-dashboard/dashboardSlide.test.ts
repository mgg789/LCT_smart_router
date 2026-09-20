import { describe, expect, it } from 'vitest';
import {
  isNavLocked,
  isStackNav,
  sidebarWheelNav,
  stackNavIndex,
  stackSlideDir,
  stackSlideEnter,
  stackSlideExit,
  stackViewKey,
} from './dashboardSlide';

describe('dashboardSlide', () => {
  it('keeps Requests in the vertical stack between day and engineers', () => {
    expect(isStackNav('requests')).toBe(true);
    expect(stackNavIndex('day')).toBe(0);
    expect(stackNavIndex('requests')).toBe(1);
    expect(stackNavIndex('engineers')).toBe(2);
    expect(stackNavIndex('ai')).toBeGreaterThan(stackNavIndex('policy'));
  });

  it('gives Requests and Engineers their own panes and shares the day pane for day / chats / AI', () => {
    expect(stackViewKey('day')).toBe('main');
    expect(stackViewKey('engineers')).toBe('engineers');
    expect(stackViewKey('chats')).toBe('main');
    expect(stackViewKey('ai')).toBe('main');
    expect(stackViewKey('requests')).toBe('requests');
    expect(stackViewKey('alerts')).toBe('alerts');
    expect(stackViewKey('policy')).toBe('policy');
  });

  it('slides down the stack from below and up the stack from above', () => {
    expect(stackSlideDir('day', 'requests')).toBe(1);
    expect(stackSlideDir('requests', 'day')).toBe(-1);
    expect(stackSlideDir('day', 'alerts')).toBe(1);
    expect(stackSlideDir('policy', 'day')).toBe(-1);
    expect(stackSlideDir('day', 'day')).toBe(0);
    expect(stackSlideEnter(1)).toEqual({ y: '100%' });
    expect(stackSlideExit(1)).toEqual({ y: '-100%' });
    expect(stackSlideEnter(-1)).toEqual({ y: '-100%' });
    expect(stackSlideExit(-1)).toEqual({ y: '100%' });
    expect(stackSlideEnter(0)).toEqual({ y: '0%' });
  });

  it('skips locked chats / AI when the sidebar wheel steps', () => {
    expect(isNavLocked('chats')).toBe(true);
    expect(isNavLocked('ai')).toBe(true);
    expect(isNavLocked('engineers')).toBe(false);
    expect(sidebarWheelNav('policy', 80)).toBe('day');
    expect(sidebarWheelNav('day', -40)).toBe('policy');
    expect(sidebarWheelNav('alerts', 10)).toBe('policy');
    expect(sidebarWheelNav('policy', 0)).toBeNull();
  });
});
