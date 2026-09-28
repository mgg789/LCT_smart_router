import { describe, expect, it } from 'vitest';
import { engineerCodeHint } from './loginHint';

describe('engineerCodeHint', () => {
  /** The demo stand always returns the code, and used to leave no way to ask for a new
   *  one — the resend control simply never rendered. */
  it('shows a local demo code and still allows a resend', () => {
    expect(engineerCodeHint({ devCode: '833455', remainingSec: 90, showDevCode: true })).toEqual({
      text: 'Демо код 833455 без срока',
      canResend: true,
    });
  });

  it('hides a leaked code on a built stand', () => {
    expect(engineerCodeHint({ devCode: '833455', remainingSec: 90, showDevCode: false })).toEqual({
      text: 'Новый код через 1:30',
      canResend: false,
    });
  });

  it('holds the resend only while the code just sent is still counting down', () => {
    expect(engineerCodeHint({ remainingSec: 60 })).toEqual({
      text: 'Новый код через 1:00',
      canResend: false,
    });
    expect(engineerCodeHint({ remainingSec: 0 })).toEqual({ text: null, canResend: true });
  });
});
