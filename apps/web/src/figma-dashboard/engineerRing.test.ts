import { describe, expect, it } from 'vitest';
import {
  arrowSpinDelta,
  bestEngineerIndex,
  givenName,
  isOnScreenSlot,
  isRenderedSlot,
  pointerAngleDeg,
  ringMounts,
  RING_CENTER,
  RING_CHAT_TOP,
  RING_SEARCH_TOP,
  ringPose,
  ringSlotKeys,
  selectionSpinTarget,
  rotationDeltaFromPointer,
  scoreEngineerMatch,
  shortestTurn,
  visibleRingCards,
  wheelStep,
  wrappedSlot,
} from './engineerRing';

describe('engineerRing', () => {
  it('keeps five on-screen slots and one extra off-screen pair', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const visible = visibleRingCards(items, 2).sort((left, right) => left.slot - right.slot);
    expect(visible.map((card) => Math.round(card.slot))).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(visible.map((card) => card.item)).toEqual(['h', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(visible.filter((card) => isOnScreenSlot(card.slot)).map((card) => card.item)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(visible.every((card) => isRenderedSlot(card.slot))).toBe(true);
    expect(visibleRingCards(items, 2).some((card) => card.item === 'g')).toBe(false);
    expect(ringSlotKeys(3)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it('clones a short roster into the off-screen extra slots', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const mounts = ringMounts(0, 5);
    expect(mounts.map((mount) => Math.round(mount.slot))).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(mounts.map((mount) => items[mount.index])).toEqual(['c', 'd', 'e', 'a', 'b', 'c', 'd']);
    const later = ringMounts(-0.4, 5);
    expect(later.find((mount) => mount.key === 0)?.slot).toBeCloseTo(0.4, 5);
    expect(later.find((mount) => mount.key === 3)?.slot).toBeCloseTo(3.4, 5);
  });

  it('leans side cards back and blurs only the outer pair', () => {
    const center = ringPose(0);
    const inner = ringPose(1);
    const outer = ringPose(2);
    expect(center.lean).toBe(0);
    expect(center.y).toBe(RING_CENTER.y);
    expect(RING_CHAT_TOP).toBe(RING_CENTER.y - 197);
    expect(RING_SEARCH_TOP).toBe(RING_CENTER.y + 149);
    expect(center.blur).toBe(0);
    expect(inner.lean).toBeGreaterThan(3);
    expect(inner.lean).toBeLessThan(6);
    expect(outer.lean).toBeGreaterThanOrEqual(inner.lean);
    expect(inner.blur).toBe(0);
    expect(outer.blur).toBeGreaterThan(0);
    expect(ringPose(-2).x).toBeLessThan(center.x);
    expect(ringPose(2).x).toBeGreaterThan(center.x);
    expect(Math.abs(ringPose(1).x - center.x - (center.x - ringPose(-1).x))).toBeLessThan(0.01);
  });

  it('turns clockwise on wheel-forward, rightward drag and the right arrow', () => {
    expect(wheelStep(120)).toBe(-1);
    expect(wheelStep(-40)).toBe(1);
    expect(arrowSpinDelta('ArrowRight')).toBe(-1);
    expect(arrowSpinDelta('ArrowLeft')).toBe(1);
    expect(arrowSpinDelta('Escape')).toBeNull();
    expect(wrappedSlot(0, -1, 8)).toBe(1);
    expect(selectionSpinTarget(-1, 4, 5)).toBeNull();
    expect(selectionSpinTarget(0, 4, 5)).toBe(-1);
    expect(selectionSpinTarget(0, 1, 5)).toBe(1);
    const delta = rotationDeltaFromPointer({ x: 900, y: 800 }, { x: 1100, y: 800 });
    expect(delta).toBeLessThan(0);
    expect(pointerAngleDeg(1037, 0)).toBeCloseTo(0, 5);
  });

  it('picks the closer direction and the tighter name match', () => {
    expect(shortestTurn(0, 1, 8)).toBe(1);
    expect(shortestTurn(0, 7, 8)).toBe(-1);
    expect(shortestTurn(2, 2, 8)).toBe(0);
    const roster = [
      { name: 'Александра Смирнова', email: 'alex@test.com' },
      { name: 'Виталий Орлов', email: 'vit@test.com' },
      { name: 'Виталий Ким', email: null },
    ];
    expect(bestEngineerIndex(roster, 'вит', 0)).toBe(1);
    expect(bestEngineerIndex(roster, 'алекс', 2)).toBe(0);
    expect(bestEngineerIndex(roster, 'zzz', 0)).toBeNull();
    expect(scoreEngineerMatch('алекс', 'Александра Смирнова', null)).toBeGreaterThan(
      scoreEngineerMatch('алекс', 'Виталий Александров', null),
    );
    expect(givenName('Бригада Иванов')).toBe('Бригада Иванов');
    expect(givenName('Александра Смирнова')).toBe('Александра');
  });
});
