import { describe, expect, it } from 'vitest';
import { formatAlertReason } from './alertsInbox';

describe('Figma ALERTS card copy', () => {
  it('keeps the reason prefix required by node 49:5698', () => {
    expect(formatAlertReason('нет инженера со навыком')).toBe('Причина: нет инженера со навыком');
  });
});
