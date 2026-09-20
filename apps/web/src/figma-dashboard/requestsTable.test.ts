import { describe, expect, it } from 'vitest';
import {
  DEMO_REQUEST_ROWS,
  filterRequestRows,
  requestRowStatus,
  requestStatusLabel,
  shortRequestAddress,
  shortRequestId,
  sortRequestRows,
} from './requestsTable';

describe('Figma REQUESTS table', () => {
  it('maps assignment states onto the three Figma chips plus unassigned', () => {
    expect(requestStatusLabel('in_progress')).toBe('В работе');
    expect(requestStatusLabel('assigned')).toBe('Назначена');
    expect(requestStatusLabel('done')).toBe('Выполнена');
    expect(requestStatusLabel('unassigned')).toBe('Без назначения');
    expect(requestStatusLabel('cancelled')).toBe('Отменена');
    expect(
      requestRowStatus({
        assignmentState: 'in_progress',
        lifecycle: 'submitted',
      } as never),
    ).toBe('in_progress');
    expect(
      requestRowStatus({
        assignmentState: 'assigned',
        lifecycle: 'completed',
        cancelledAt: null,
      } as never),
    ).toBe('done');
    expect(
      requestRowStatus({
        assignmentState: 'assigned',
        lifecycle: 'cancelled',
        cancelledAt: 1,
      } as never),
    ).toBe('cancelled');
  });

  it('shows only the first 8-character id segment in the UI', () => {
    expect(shortRequestId('77cc60e5-b833-4500-8a2c-c1f7e0c338bb')).toBe('77cc60e5');
    expect(shortRequestId('1024')).toBe('1024');
  });

  it('keeps a short street line and filters by number or address', () => {
    expect(shortRequestAddress('Москва, ул. Таганская, 24')).toBe('ул. Таганская, 24');
    const found = filterRequestRows(DEMO_REQUEST_ROWS, 'пятниц');
    expect(found.every((row) => row.address.includes('Пятницкая'))).toBe(true);
    expect(filterRequestRows(DEMO_REQUEST_ROWS, '1254')).toHaveLength(1);
  });

  it('sorts in-progress first by usage, then by number', () => {
    const byUsage = sortRequestRows(DEMO_REQUEST_ROWS, 'usage');
    expect(byUsage[0]?.status).toBe('in_progress');
    expect(byUsage[byUsage.length - 1]?.status).toBe('done');
    const byNumber = sortRequestRows(DEMO_REQUEST_ROWS, 'number');
    expect(byNumber[0]?.number).toBe('1024');
    expect(byNumber[byNumber.length - 1]?.number).toBe('1254');
  });
});
