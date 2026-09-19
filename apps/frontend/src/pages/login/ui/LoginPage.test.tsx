import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { LoginPage } from './LoginPage';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function renderPage() {
  return renderWithProviders(<LoginPage />);
}

beforeEach(() => {
  useSessionStore.getState().signOut();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('will not email a code before consent is given', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({});
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'dispatcher@navix.test');
    await user.click(screen.getByRole('button', { name: 'Новый код' }));

    expect(await screen.findByText('Нужно согласие на обработку данных.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the API for a code and confirms the letter went out', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      '/auth/login-code': () =>
        jsonResponse({ email: 'dispatcher@navix.test', expiresAt: nowSeconds() + 600 }),
    });
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'dispatcher@navix.test');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Новый код' }));

    expect(await screen.findByText(/Код отправлен на dispatcher@navix.test/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/auth/login-code');
    expect(init?.body).toBe(JSON.stringify({ email: 'dispatcher@navix.test' }));
  });

  it('verifies the six-digit code as a dispatcher and stores the session', async () => {
    const user = userEvent.setup();
    const expiresAt = nowSeconds() + 86_400;
    const fetchMock = stubApi({
      '/auth/login-code/verify': () =>
        jsonResponse({ token: 'tok-42', role: 'dispatcher', expiresAt }),
    });
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'dispatcher@navix.test');
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Цифра 1'), '123456');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => {
      expect(useSessionStore.getState().session).toEqual({
        token: 'tok-42',
        role: 'dispatcher',
        expiresAt,
        email: 'dispatcher@navix.test',
      });
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe(
      JSON.stringify({ email: 'dispatcher@navix.test', code: '123456', role: 'dispatcher' }),
    );
  });

  it('refuses a short code without calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({});
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'dispatcher@navix.test');
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Цифра 1'), '123');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Код из письма — 6 цифр.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a rejected code instead of showing the raw envelope', async () => {
    const user = userEvent.setup();
    stubApi({
      '/auth/login-code/verify': () =>
        jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'bad code' } }, 401),
    });
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'dispatcher@navix.test');
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Цифра 1'), '000000');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Код не подошёл или истёк. Запросите новый.',
    );
    expect(useSessionStore.getState().session).toBeNull();
  });
});
