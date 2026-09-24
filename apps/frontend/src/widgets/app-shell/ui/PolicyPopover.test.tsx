import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { PolicyPopover } from './PolicyPopover';

const POLICIES = {
  policies: [
    { policyId: 'fast', title: 'Fast', description: '', isDefault: false },
    { policyId: 'compact', title: 'Compact', description: '', isDefault: true },
    { policyId: 'covering', title: 'Covering', description: '', isDefault: false },
  ],
  active: { policyId: 'compact', version: 2, changedAt: 1_789_460_000 },
};

const SETTINGS = {
  lunchesEnabled: false,
  departureLatenessToleranceSec: 0,
  travelTimeMode: 'graph_with_access_buffer',
  accessBufferSec: 600,
  routerContextVersion: 'ctx-1',
};

const PLAN = { mode: 'auto', modeVersion: 4, plan: null, appliedResult: null, lastResult: null };

function stubAll(overrides: Record<string, () => Response> = {}) {
  return stubApi({
    '/dispatch/policies': () => jsonResponse(POLICIES),
    '/dispatch/router/technical-settings': () => jsonResponse(SETTINGS),
    '/dispatch/plan': () => jsonResponse(PLAN),
    ...overrides,
  });
}

async function settle() {
  await screen.findByRole('radio', { name: /Меньше инженеров/ });
  await act(async () => {
    await Promise.resolve();
  });
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

describe('PolicyPopover', () => {
  it('lists the presets the API offers, named in Russian', async () => {
    stubAll();
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    expect(screen.getByRole('radio', { name: /Быстрее до клиента/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Полное покрытие/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Меньше инженеров/ })).toBeChecked();
  });

  it('switches the policy through POST /dispatch/policy', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll({ '/dispatch/policy': () => jsonResponse({ policyId: 'fast' }) });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('radio', { name: /Быстрее до клиента/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dispatch/policy'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.policyId).toBe('fast');
      expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('does not republish when the active policy is clicked again', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll();
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('radio', { name: /Меньше инженеров/ }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/dispatch/policy'))).toBe(
      false,
    );
  });

  it('turns lunches on by echoing the revision it just read', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll({
      '/dispatch/router/technical-settings': () => jsonResponse(SETTINGS),
    });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('switch', { name: 'Рассчитать обеды' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String(put?.[1]?.body ?? '{}'));
      expect(body.lunchesEnabled).toBe(true);
      expect(body.expectedContextVersion).toBe('ctx-1');
      // Fields this client never names must survive the round trip untouched.
      expect(body.accessBufferSec).toBe(600);
      expect(body.travelTimeMode).toBe('graph_with_access_buffer');
      expect(body.routerContextVersion).toBeUndefined();
    });
  });

  it('offers MANUAL while the contour is in AUTO', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll({
      '/dispatch/mode': () => jsonResponse({ control: { mode: 'manual', modeVersion: 5 } }),
    });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('button', { name: 'Ручное управление' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dispatch/mode'));
      expect(JSON.parse(String(call?.[1]?.body ?? '{}')).mode).toBe('manual');
    });
  });

  it('offers the way back while the contour is in MANUAL', async () => {
    stubAll({ '/dispatch/plan': () => jsonResponse({ ...PLAN, mode: 'manual' }) });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    expect(
      await screen.findByRole('button', { name: 'Вернуть автоматический режим' }),
    ).toBeInTheDocument();
  });
});
