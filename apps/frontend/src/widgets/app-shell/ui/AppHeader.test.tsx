import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { AppHeader } from './AppHeader';

const POLICIES = {
  policies: [
    { policyId: 'fast', title: 'Быстрее до клиента', description: '', isDefault: false },
    { policyId: 'compact', title: 'Меньше инженеров', description: '', isDefault: true },
  ],
  active: { policyId: 'compact', version: 2, changedAt: 1_789_460_000 },
};

/** Waits for both header queries so no state update lands outside act(). */
async function settle() {
  await screen.findByText(/^Политика: /);
  await screen.findByLabelText(/^Алерты/);
  // Both queries resolve in the same tick; flush the trailing render inside act.
  await act(async () => {
    await Promise.resolve();
  });
}

function alertsWith(unseen: number, seen = 0) {
  const make = (index: number, seenAt: number | null) => ({
    id: `alert-${index}-${seenAt ?? 'new'}`,
    code: 'UNASSIGNED',
    severity: 'warning',
    engineerIds: [],
    requestIds: [],
    reasons: [],
    createdAt: 1_789_460_000,
    seenAt,
    resolvedAt: null,
  });
  return {
    alerts: [
      ...Array.from({ length: unseen }, (_, index) => make(index, null)),
      ...Array.from({ length: seen }, (_, index) => make(index, 1_789_460_100)),
    ],
  };
}

beforeEach(() => {
  useSessionStore.getState().signIn({
    token: 'tok-1',
    role: 'dispatcher',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    email: 'anna.smirnova@navix.test',
  });
});

afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

describe('AppHeader', () => {
  it('names the policy in force using the title the API gave', async () => {
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/alerts': () => jsonResponse(alertsWith(0)),
    });
    renderWithProviders(<AppHeader />);
    await settle();

    expect(screen.getByText('Политика: Меньше инженеров')).toBeInTheDocument();
  });

  it('says so instead of guessing when the policy cannot be read', async () => {
    stubApi({
      '/dispatch/policies': () =>
        jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500),
      '/dispatch/alerts': () => jsonResponse(alertsWith(0)),
    });
    renderWithProviders(<AppHeader />);
    await settle();

    expect(screen.getByText('Политика: нет связи')).toBeInTheDocument();
  });

  it('counts only alerts nobody has looked at yet', async () => {
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/alerts': () => jsonResponse(alertsWith(3, 5)),
    });
    renderWithProviders(<AppHeader />);
    await settle();

    expect(screen.getByLabelText('Алерты, непросмотренных: 3')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('drops the session when the dispatcher signs out', async () => {
    const user = userEvent.setup();
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/alerts': () => jsonResponse(alertsWith(0)),
      '/auth/session': () => jsonResponse({ signedOut: true }),
    });
    renderWithProviders(<AppHeader />);
    await settle();

    await user.click(screen.getByLabelText('Меню аккаунта'));
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    await waitFor(() => expect(useSessionStore.getState().session).toBeNull());
  });

  it('does not offer a search it cannot run yet', async () => {
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/alerts': () => jsonResponse(alertsWith(0)),
    });
    renderWithProviders(<AppHeader />);
    await settle();

    expect(screen.getByLabelText(/Поиск появится/)).toBeDisabled();
  });
});
