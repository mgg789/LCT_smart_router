import { describe, expect, it } from 'vitest';
import {
  kmPerAssignment,
  minutesPerAssignment,
  percentVsBaseline,
  strategyDescription,
  strategyTitle,
} from './comparison';

describe('policy comparison labels', () => {
  it('calls the FIFO row the baseline from the case statement', () => {
    expect(strategyTitle('baseline')).toBe('Базовая из ТЗ');
    expect(strategyDescription('baseline')).toContain('первому подходящему свободному инженеру');
  });

  it('names a policy the way the header pill does', () => {
    expect(strategyTitle('fast')).toBe('Быстрее до клиента');
  });
});

describe('percentVsBaseline', () => {
  it('signs the change against FIFO', () => {
    expect(percentVsBaseline(120, 100)).toBe('+20%');
    expect(percentVsBaseline(75, 100)).toBe('-25%');
    expect(percentVsBaseline(100, 100)).toBe('0%');
  });

  it('says nothing where a percentage would mean nothing', () => {
    expect(percentVsBaseline(10, 0)).toBeNull();
    expect(percentVsBaseline(null, 100)).toBeNull();
    expect(percentVsBaseline(10, null)).toBeNull();
  });
});

describe('per-assignment figures', () => {
  it('divides by the assigned requests', () => {
    expect(kmPerAssignment(30, 4)).toBe('7,5 км/назначение');
    expect(minutesPerAssignment(3600, 4)).toBe('15 мин/назначение');
  });

  it('does not divide by nothing', () => {
    expect(kmPerAssignment(30, 0)).toBe('— км/назначение');
    expect(minutesPerAssignment(3600, 0)).toBe('— мин/назначение');
  });
});
