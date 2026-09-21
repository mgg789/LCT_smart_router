import { formatCodeCountdown } from '../figma-dashboard/loginCopy';

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
  /** Local Vite/dev only. Built stands never print a mailbox code. */
  showDevCode?: boolean;
}): EngineerCodeHint {
  if (input.showDevCode && input.devCode) {
    return { kind: 'demo', text: `Демо код ${input.devCode} без срока` };
  }
  if (input.remainingSec > 0) {
    return { kind: 'countdown', text: formatCodeCountdown(input.remainingSec) };
  }
  return { kind: 'resend' };
}
