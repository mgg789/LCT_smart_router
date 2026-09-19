import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_LOGIN_TITLE,
  ENGINEER_LOGIN_TITLE,
  isLoginEmail,
  loginErrorMessage,
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
});
