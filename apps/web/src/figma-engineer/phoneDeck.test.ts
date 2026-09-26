import { describe, expect, it } from 'vitest';
import { readPhoneDeck } from './phoneDeck';

describe('readPhoneDeck', () => {
  it('is a plain column on a phone, portrait or landscape', () => {
    expect(readPhoneDeck({ width: 390, height: 844 })).toEqual({ deck: false, pane: false });
    expect(readPhoneDeck({ width: 844, height: 390 })).toEqual({ deck: false, pane: false });
  });

  it('gives a tablet the card but not a second one beside it', () => {
    expect(readPhoneDeck({ width: 1024, height: 768 })).toEqual({ deck: true, pane: false });
  });

  it('gives a laptop and a monitor both cards', () => {
    expect(readPhoneDeck({ width: 1440, height: 900 })).toEqual({ deck: true, pane: true });
    expect(readPhoneDeck({ width: 2560, height: 1440 })).toEqual({ deck: true, pane: true });
  });

  it('keeps a wide but short window a column: a card would only eat its height', () => {
    expect(readPhoneDeck({ width: 1920, height: 420 })).toEqual({ deck: false, pane: false });
  });

  it('never offers a second pane without the card that holds the first', () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1024, height: 768 },
      { width: 1920, height: 420 },
      { width: 1440, height: 900 },
    ]) {
      const { deck, pane } = readPhoneDeck(viewport);
      expect(pane && !deck).toBe(false);
    }
  });
});
