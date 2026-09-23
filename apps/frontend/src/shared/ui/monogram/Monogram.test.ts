import { describe, expect, it } from 'vitest';
import { initialsOf } from './Monogram';

describe('initialsOf', () => {
  it('takes two letters from a full name', () => {
    expect(initialsOf('Александра Смирнова')).toBe('АС');
  });

  it('reads an address before the @, splitting on dots', () => {
    expect(initialsOf('anna.smirnova@navix.test')).toBe('AS');
  });

  it('falls back to one letter when there is only one word', () => {
    expect(initialsOf('dispatcher@navix.test')).toBe('D');
  });

  it('never renders empty', () => {
    expect(initialsOf('')).toBe('?');
  });
});
