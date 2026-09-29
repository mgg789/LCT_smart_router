import { describe, expect, it } from 'vitest';
import { policyLabel } from '../figma-dashboard/fromSnapshot';
import {
  perAssignmentDuration,
  perAssignmentKm,
  percentVsFifo,
  strategyDescription,
  strategyLabel,
} from './policyComparison';

describe('policy comparison labels', () => {
  it('names compact and the TZ baseline the way the dispatcher page does', () => {
    expect(strategyLabel('compact')).toBe('Дешевле');
    expect(strategyLabel('fast')).toBe('Быстрее до клиента');
    expect(strategyLabel('baseline')).toBe('FIFO · базовая из ТЗ');
    expect(strategyDescription('baseline')).toContain('очереди');
  });

  it('gives every policy one name, the picker and the comparison alike', () => {
    for (const id of ['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const) {
      expect(strategyLabel(id)).toBe(policyLabel(id));
    }
  });

  it('formats per-assignment extras and FIFO deltas', () => {
    expect(perAssignmentKm(12.3, 0)).toBe('— км/назначение');
    expect(perAssignmentKm(12.3, 10)).toBe('1,2 км/назначение');
    expect(perAssignmentDuration(600, 2)).toBe('5 мин/назначение');
    expect(percentVsFifo(120, 100)).toBe('+20%');
    expect(percentVsFifo(80, 100)).toBe('-20%');
    expect(percentVsFifo(10, 0)).toBeNull();
  });
});
