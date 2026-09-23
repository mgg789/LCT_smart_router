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

    await user.click(screen.getByRole('switch', { name: 'Обед включён' }));

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

  it('requires a reason and sends the current mode and plan versions for MANUAL', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll({
      '/dispatch/mode': () => jsonResponse({ control: { mode: 'manual', modeVersion: 5 } }),
    });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('button', { name: 'Ручное управление' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/dispatch/mode'))).toBe(
      false,
    );
    const reason = await screen.findByRole('textbox', { name: 'Причина перехода в MANUAL' });
    await user.type(reason, '   ');
    expect(screen.getByRole('button', { name: 'Подтвердить MANUAL' })).toBeDisabled();
    await user.clear(reason);
    await user.type(reason, '  Авария на линии  ');
    await user.click(screen.getByRole('button', { name: 'Подтвердить MANUAL' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dispatch/mode'));
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        mode: 'manual',
        reason: 'Авария на линии',
        expectedModeVersion: 4,
        expectedPlanRevision: 0,
      });
    });
  });

  it('returns to AUTO with version guards and no reason', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAll({
      '/dispatch/plan': () => jsonResponse({ ...PLAN, mode: 'manual', modeVersion: 5 }),
      '/dispatch/mode': () => jsonResponse({ control: { mode: 'auto', modeVersion: 6 } }),
    });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(await screen.findByRole('button', { name: 'Вернуть автоматический режим' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dispatch/mode'));
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        mode: 'auto',
        expectedModeVersion: 5,
        expectedPlanRevision: 0,
      });
      expect(JSON.parse(String(call?.[1]?.body ?? '{}')).reason).toBeUndefined();
    });
  });

  it('reloads a changed plan and leaves the reason available after a version conflict', async () => {
    const user = userEvent.setup();
    let current = PLAN;
    const fetchMock = stubAll({
      '/dispatch/plan': () => jsonResponse(current),
      '/dispatch/mode': () => {
        current = { ...PLAN, modeVersion: 6 };
        return jsonResponse({ error: { code: 'VERSION_CONFLICT', message: 'Plan changed' } }, 409);
      },
    });
    renderWithProviders(<PolicyPopover onClose={() => {}} />);
    await settle();

    await user.click(screen.getByRole('button', { name: 'Ручное управление' }));
    await user.type(screen.getByRole('textbox', { name: 'Причина перехода в MANUAL' }), 'Сбой');
    await user.click(screen.getByRole('button', { name: 'Подтвердить MANUAL' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('План изменился');
    expect(screen.getByRole('textbox', { name: 'Причина перехода в MANUAL' })).toHaveValue('Сбой');
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/dispatch/plan')).length,
      ).toBeGreaterThan(1);
    });
  });
});
