import { describe, expect, it } from 'vitest';
import { readPhoneDesk } from './phoneDesk';

describe('readPhoneDesk', () => {
  it('is the phone column on a phone, portrait or landscape', () => {
    expect(readPhoneDesk({ width: 390, height: 844 })).toBe(false);
    expect(readPhoneDesk({ width: 844, height: 390 })).toBe(false);
  });

  it('is the phone column on a tablet: two panes there would be three lines each', () => {
    expect(readPhoneDesk({ width: 1024, height: 768 })).toBe(false);
  });

  it('is a desk on a laptop and on a monitor', () => {
    expect(readPhoneDesk({ width: 1440, height: 900 })).toBe(true);
    expect(readPhoneDesk({ width: 2560, height: 1440 })).toBe(true);
  });

  it('stays a column in a wide but short window, which has no height for panes', () => {
    expect(readPhoneDesk({ width: 1920, height: 500 })).toBe(false);
  });
});
