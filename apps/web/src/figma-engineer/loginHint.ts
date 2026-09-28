import { formatCodeCountdown } from '../figma-dashboard/loginCopy';
import { t } from '../i18n';

export interface EngineerCodeHint {
  /** Line under the OTP cells: the local demo code, or how long the sent one lasts. */
  readonly text: string | null;
  /** Whether «Новый код» may be pressed now. */
  readonly canResend: boolean;
}

/**
 * Copy and resend state under the OTP cells.
 *
 * The resend control is always offered, only disabled while the code that was just
 * sent is still counting down. It used to appear solely once that countdown reached
 * zero and no demo code was present — so on the demo stand, where the API returns the
 * code, there was no way to ask for a new one at all, and in production a letter that
 * never arrived meant waiting out the whole TTL before the button existed.
 */
export function engineerCodeHint(input: {
  devCode?: string;
  remainingSec: number;
  /** True when the API returned a code. A production bundle still prints it. */
  showDevCode?: boolean;
}): EngineerCodeHint {
  if (input.showDevCode && input.devCode) {
    return {
      text: t('figma-engineer.loginHint.9015168dcd', { value0: input.devCode }),
      canResend: true,
    };
  }
  if (input.remainingSec > 0) {
    return { text: formatCodeCountdown(input.remainingSec), canResend: false };
  }
  return { text: null, canResend: true };
}
