import { describe, expect, it } from 'vitest';
import { applyOtpBackspace, applyOtpInput, emptyOtpCells, otpValue } from './otp';

describe('OTP cells', () => {
  it('accepts one digit and advances the caret', () => {
    const next = applyOtpInput(emptyOtpCells(), 0, '8');
    expect(otpValue(next.cells)).toBe('8');
    expect(next.focus).toBe(1);
  });

  it('drops letters and other marks', () => {
    const next = applyOtpInput(emptyOtpCells(), 0, 'aB-');
    expect(otpValue(next.cells)).toBe('');
    expect(next.focus).toBe(0);
  });

  it('fills from a paste and parks the caret on the last cell', () => {
    const next = applyOtpInput(emptyOtpCells(), 0, '83 34-55');
    expect(otpValue(next.cells)).toBe('833455');
    expect(next.focus).toBe(5);
  });

  it('moves back and clears the previous cell when the current one is empty', () => {
    const filled = applyOtpInput(emptyOtpCells(), 0, '12');
    const cleared = applyOtpBackspace(filled.cells, filled.focus);
    expect(otpValue(cleared.cells)).toBe('1');
    expect(cleared.focus).toBe(1);
  });
});
