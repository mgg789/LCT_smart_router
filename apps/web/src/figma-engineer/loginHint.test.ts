import { describe, expect, it } from 'vitest';
import { engineerCodeHint } from './loginHint';

describe('engineerCodeHint', () => {
  it('shows a local demo code without a countdown', () => {
    expect(engineerCodeHint({ devCode: '833455', remainingSec: 90 })).toEqual({
      kind: 'demo',
      text: 'Демо код 833455 без срока',
    });
  });

  it('counts down in production, then offers a resend', () => {
    expect(engineerCodeHint({ remainingSec: 60 })).toEqual({
      kind: 'countdown',
      text: 'Новый код через 1:00',
    });
    expect(engineerCodeHint({ remainingSec: 0 })).toEqual({ kind: 'resend' });
  });
});
