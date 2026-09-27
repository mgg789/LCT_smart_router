import { t } from '../i18n';
export const ENGINEER_LOGIN_TITLE = t('figma-dashboard.loginCopy.16db9051fe');
export const DISPATCHER_LOGIN_TITLE = t('figma-dashboard.loginCopy.6031d330e6');

export const ENGINEER_LOGIN_LEAD = t('figma-dashboard.loginCopy.b62803d27e');
export const DISPATCHER_LOGIN_LEAD = t('figma-dashboard.loginCopy.d27c460ebb');

/** Matches the API default `LOGIN_CODE_TTL_SEC`. */
export const LOGIN_CODE_TTL_SEC = 90;

/** Lightweight client check before we hit the login-code endpoint. */
export function isLoginEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Maps API/English login failures onto dispatcher-facing Russian copy.
 * Unknown English strings collapse to a generic retry line so we never show
 * "The code is invalid or has expired" in the UI.
 */
export function loginErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '');
  const text = raw.trim();
  if (!text) return t('figma-dashboard.loginCopy.63ec059925');
  if (/проверьте|неверн|истёк|истек|не удалось|нет связи|не ответил|сессия/i.test(text)) {
    return text;
  }
  if (/invalid or has expired|six digits/i.test(text)) {
    return t('figma-dashboard.loginCopy.24229e4cf7');
  }
  if (/invalid dispatcher credentials/i.test(text)) {
    return t('figma-dashboard.loginCopy.a30ae615b8');
  }
  if (/unauthenticated|forbidden|401|403/i.test(text)) {
    return t('figma-dashboard.loginCopy.78fb24c5e0');
  }
  if (/validation|email|422/i.test(text)) {
    return t('figma-dashboard.loginCopy.78bbe6d207');
  }
  if (/нет связи|не ответил|failed to fetch|network/i.test(text)) {
    return t('figma-dashboard.loginCopy.04090a12a4');
  }
  if (/[А-Яа-яЁё]/.test(text)) return text;
  return t('figma-dashboard.loginCopy.63ec059925');
}

/** Seconds left until `expiresAt` (unix seconds). Never negative. */
export function remainingCodeSeconds(expiresAt: number, nowMs = Date.now()): number {
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - Math.floor(nowMs / 1000));
}

/** Production hint under the OTP cells while a code is still live. */
export function formatCodeCountdown(remainingSec: number): string {
  const clamped = Math.max(0, Math.floor(remainingSec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return t('figma-dashboard.loginCopy.76605546d6', {
    value0: minutes,
    value1: seconds.toString().padStart(2, '0'),
  });
}
