import { formatCodeCountdown } from '../figma-dashboard/loginCopy';
import { t } from '../i18n';

export type EngineerCodeHint =
  | { readonly kind: 'demo'; readonly text: string }
  | { readonly kind: 'countdown'; readonly text: string }
  | { readonly kind: 'resend' };

/**
 * Copy under the OTP cells: local demo code has no TTL;
 * production shows the countdown, then a resend button.
 */
export function engineerCodeHint(input: {
  devCode?: string;
  remainingSec: number;
  /** True when the API returned a code. A production bundle still prints it. */
  showDevCode?: boolean;
}): EngineerCodeHint {
  if (input.showDevCode && input.devCode) {
    return {
      kind: 'demo',
      text: t('figma-engineer.loginHint.9015168dcd', { value0: input.devCode }),
    };
  }
  if (input.remainingSec > 0) {
    return { kind: 'countdown', text: formatCodeCountdown(input.remainingSec) };
  }
  return { kind: 'resend' };
}
