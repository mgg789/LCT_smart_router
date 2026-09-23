import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { AlertsPopover } from './AlertsPopover';

function alert(id: string, code: string, severity: string, seenAt: number | null = null) {
  return {
    id,
    code,
    severity,
    engineerIds: [],
    requestIds: [],
    reasons: [],
    createdAt: 1_789_460_000,
    seenAt,
    resolvedAt: null,
  };
}

beforeEach(() => {
  useSessionStore.getState().signIn({
    token: 'tok',
    role: 'dispatcher',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    email: 'd@navix.test',
  });
});

afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

describe('AlertsPopover', () => {
  it('renders the documented codes in Russian', async () => {
    stubApi({
      '/dispatch/alerts': () => jsonResponse({ alerts: [alert('a1', 'NO_SKILL_MATCH', 'error')] }),
    });
    renderWithProviders(<AlertsPopover onClose={() => {}} />);

    expect(await screen.findByText('Нет инженера с нужным навыком')).toBeInTheDocument();
  });

  it('shows an unknown code as it came instead of inventing a phrase', async () => {
    stubApi({
      '/dispatch/alerts': () => jsonResponse({ alerts: [alert('a1', 'SOMETHING_NEW', 'warning')] }),
    });
    renderWithProviders(<AlertsPopover onClose={() => {}} />);

    expect(await screen.findByText('SOMETHING_NEW')).toBeInTheDocument();
  });

  it('previews at most three alerts and skips the ones already seen', async () => {
    stubApi({
      '/dispatch/alerts': () =>
        jsonResponse({
          alerts: [
            alert('a1', 'NO_SKILL_MATCH', 'error'),
            alert('a2', 'NO_TRANSPORT_MATCH', 'warning'),
            alert('a3', 'NO_EQUIPMENT_STOCK', 'warning'),
            alert('a4', 'NO_AVAILABLE_ENGINEER', 'info'),
            alert('a5', 'LUNCH_NOT_PLACED', 'info', 1_789_460_100),
          ],
        }),
    });
    renderWithProviders(<AlertsPopover onClose={() => {}} />);

    expect(await screen.findByText('Нет инженера с нужным навыком')).toBeInTheDocument();
    expect(await screen.findAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('Нет доступного инженера')).not.toBeInTheDocument();
    expect(screen.queryByText('Обед не удалось поставить')).not.toBeInTheDocument();
  });

  it('says there is nothing rather than showing an empty card', async () => {
    stubApi({ '/dispatch/alerts': () => jsonResponse({ alerts: [] }) });
    renderWithProviders(<AlertsPopover onClose={() => {}} />);

    expect(await screen.findByText('Новых алертов нет.')).toBeInTheDocument();
  });

  it('closes when the dispatcher follows the link to the section', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stubApi({ '/dispatch/alerts': () => jsonResponse({ alerts: [] }) });
    renderWithProviders(<AlertsPopover onClose={onClose} />);

    await user.click(await screen.findByRole('link', { name: /К Алёртам/ }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stubApi({ '/dispatch/alerts': () => jsonResponse({ alerts: [] }) });
    renderWithProviders(<AlertsPopover onClose={onClose} />);
    await screen.findByText('Новых алертов нет.');

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
