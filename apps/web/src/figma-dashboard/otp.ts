export const OTP_LENGTH = 6;

export type OtpCells = string[];

/** Six empty digit cells for the confirmation-code step. */
export function emptyOtpCells(): OtpCells {
  return Array.from({ length: OTP_LENGTH }, () => '');
}

/** Joins filled cells into the code the API expects. */
export function otpValue(cells: readonly string[]): string {
  return cells.join('');
}

/**
 * Writes digits into cells starting at `index`. Letters and other marks are dropped.
 * A multi-digit paste fills this cell and the ones after it.
 */
export function applyOtpInput(
  cells: readonly string[],
  index: number,
  raw: string,
): { cells: OtpCells; focus: number } {
  const digits = raw.replace(/\D/g, '');
  const next = [...cells];
  while (next.length < OTP_LENGTH) next.push('');
  if (digits.length === 0) {
    next[index] = '';
    return { cells: next.slice(0, OTP_LENGTH), focus: index };
  }
  let cursor = Math.max(0, Math.min(index, OTP_LENGTH - 1));
  for (const digit of digits) {
    if (cursor >= OTP_LENGTH) break;
    next[cursor] = digit;
    cursor += 1;
  }
  return {
    cells: next.slice(0, OTP_LENGTH),
    focus: Math.min(cursor, OTP_LENGTH - 1),
  };
}

/**
 * Backspace clears the current cell, or the previous one when the current cell is empty.
 */
export function applyOtpBackspace(
  cells: readonly string[],
  index: number,
): { cells: OtpCells; focus: number } {
  const next = [...cells];
  while (next.length < OTP_LENGTH) next.push('');
  if (next[index]) {
    next[index] = '';
    return { cells: next.slice(0, OTP_LENGTH), focus: index };
  }
  if (index <= 0) return { cells: next.slice(0, OTP_LENGTH), focus: 0 };
  next[index - 1] = '';
  return { cells: next.slice(0, OTP_LENGTH), focus: index - 1 };
}
