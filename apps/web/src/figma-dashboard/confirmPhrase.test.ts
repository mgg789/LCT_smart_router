import { describe, expect, it } from 'vitest';
import { isManualConfirmInput, phraseMatches } from './confirmPhrase';

describe('confirmPhrase', () => {
  it('accepts only the exact shown word', () => {
    expect(phraseMatches('ЗАВЕРШИТЬ', 'ЗАВЕРШИТЬ')).toBe(true);
    expect(phraseMatches('  ЗАВЕРШИТЬ  ', 'ЗАВЕРШИТЬ')).toBe(true);
    expect(phraseMatches('завершить', 'ЗАВЕРШИТЬ')).toBe(false);
    expect(phraseMatches('ЗАВЕРШИ', 'ЗАВЕРШИТЬ')).toBe(false);
  });

  it('allows typing and deletions, not paste or drop', () => {
    expect(isManualConfirmInput('insertText')).toBe(true);
    expect(isManualConfirmInput('insertCompositionText')).toBe(true);
    expect(isManualConfirmInput('deleteContentBackward')).toBe(true);
    expect(isManualConfirmInput('insertFromPaste')).toBe(false);
    expect(isManualConfirmInput('insertFromDrop')).toBe(false);
    expect(isManualConfirmInput('insertReplacementText')).toBe(false);
  });
});
