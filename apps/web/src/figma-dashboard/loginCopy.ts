export const ENGINEER_LOGIN_TITLE = 'Вход инженера';
export const DISPATCHER_LOGIN_TITLE = 'Вход диспетчера';

export const ENGINEER_LOGIN_LEAD =
  'Почта бригады и код из письма. Роль выдаёт диспетчер, ввод адреса сам её не создаёт.';
export const DISPATCHER_LOGIN_LEAD =
  'Код придёт на почту диспетчера. Пароль остаётся запасным входом.';

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
  if (!text) return 'Не удалось войти. Попробуйте ещё раз.';
  if (/проверьте|неверн|истёк|истек|не удалось|нет связи|не ответил|сессия/i.test(text)) {
    return text;
  }
  if (/invalid or has expired|six digits/i.test(text)) {
    return 'Код неверный или уже истёк.';
  }
  if (/invalid dispatcher credentials/i.test(text)) {
    return 'Неверная почта или пароль.';
  }
  if (/unauthenticated|forbidden|401|403/i.test(text)) {
    return 'Не удалось подтвердить вход. Проверьте данные и попробуйте снова.';
  }
  if (/validation|email|422/i.test(text)) {
    return 'Проверьте адрес почты.';
  }
  if (/нет связи|не ответил|failed to fetch|network/i.test(text)) {
    return 'Нет связи с сервером.';
  }
  if (/[А-Яа-яЁё]/.test(text)) return text;
  return 'Не удалось войти. Попробуйте ещё раз.';
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
  return `Новый код через ${minutes}:${seconds.toString().padStart(2, '0')}`;
}
