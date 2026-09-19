import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_LOGIN_TITLE,
  ENGINEER_LOGIN_TITLE,
  formatCodeCountdown,
  LOGIN_CODE_TTL_SEC,
  isLoginEmail,
  loginErrorMessage,
  remainingCodeSeconds,
} from './loginCopy';

describe('login copy', () => {
  it('keeps role titles in Russian', () => {
    expect(ENGINEER_LOGIN_TITLE).toBe('Вход инженера');
    expect(DISPATCHER_LOGIN_TITLE).toBe('Вход диспетчера');
  });

  it('translates the English code-expired reply', () => {
    expect(loginErrorMessage(new Error('The code is invalid or has expired'))).toBe(
      'Код неверный или уже истёк.',
    );
    expect(loginErrorMessage(new Error('Invalid dispatcher credentials'))).toBe(
      'Неверная почта или пароль.',
    );
    expect(isLoginEmail('mail@mail.izz')).toBe(true);
    expect(isLoginEmail('not-mail')).toBe(false);
  });

  it('formats the production resend countdown from expiresAt', () => {
    expect(LOGIN_CODE_TTL_SEC).toBe(90);
    expect(formatCodeCountdown(90)).toBe('Новый код через 1:30');
    expect(formatCodeCountdown(5)).toBe('Новый код через 0:05');
    expect(remainingCodeSeconds(1_000, 1_000_000)).toBe(0);
    expect(remainingCodeSeconds(1_010, 1_000_000)).toBe(10);
  });
});
