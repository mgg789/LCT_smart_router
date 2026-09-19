import { describe, expect, it } from 'vitest';
import {
  MAP_BEE,
  MAP_CANVAS,
  MAP_INK,
  MAP_LUNCH_FILL,
  MAP_LUNCH_STROKE,
  MAP_MUTED,
  mapLunchColor,
  mapPaintColor,
  pillDashLine,
  stopRadiusPx,
  visibleStopLabelIds,
} from './mapPaint';

describe('map paint tokens', () => {
  it('remaps the Figma overlay palette including close legacy variants', () => {
    expect(mapPaintColor('#202124')).toBe(MAP_INK);
    expect(mapPaintColor('#5E636A')).toBe(MAP_MUTED);
    expect(mapPaintColor('#5F6368')).toBe(MAP_MUTED);
    expect(mapPaintColor('#EDB700')).toBe(MAP_BEE);
    expect(mapPaintColor('#E5B900')).toBe(MAP_BEE);
    expect(mapPaintColor('#ffffff')).toBe(MAP_CANVAS);
    expect(mapPaintColor('#1F8A4C')).toBe('#1F8A4C');
  });

  it('remaps lunch fill and stroke separately from the general palette', () => {
    expect(mapLunchColor('#F07304')).toBe(MAP_LUNCH_STROKE);
    expect(mapLunchColor('#FFE6BD')).toBe(MAP_LUNCH_FILL);
    expect(mapLunchColor('#E07A2F')).toBe(MAP_LUNCH_STROKE);
    expect(mapLunchColor('#FFE7C2')).toBe(MAP_LUNCH_FILL);
  });

  it('hides the lower stop number when two circles overlap', () => {
    const radius = stopRadiusPx(false);
    const visible = visibleStopLabelIds([
      { id: 'four', x: 0, y: 0, selected: false, z: 1 },
      { id: 'six', x: radius, y: 0, selected: false, z: 2 },
    ]);
    expect([...visible]).toEqual(['six']);
  });

  it('keeps both numbers when circles do not touch, and prefers the selected stop', () => {
    const far = visibleStopLabelIds([
      { id: 'a', x: 0, y: 0, selected: false, z: 1 },
      { id: 'b', x: 80, y: 0, selected: false, z: 2 },
    ]);
    expect([...far].sort()).toEqual(['a', 'b']);
    const selectedOnTop = visibleStopLabelIds([
      { id: 'under', x: 0, y: 0, selected: false, z: 1 },
      { id: 'pick', x: 8, y: 0, selected: true, z: 99 },
    ]);
    expect([...selectedOnTop]).toEqual(['pick']);
  });

  it('splits a long schematic hop into rounded dash capsules', () => {
    const hops = pillDashLine(
      [
        [37.6, 55.75],
        [37.62, 55.75],
      ],
      200,
      150,
    );
    expect(hops.length).toBeGreaterThan(2);
    expect(hops[0]?.length).toBeGreaterThanOrEqual(2);
  });
});
