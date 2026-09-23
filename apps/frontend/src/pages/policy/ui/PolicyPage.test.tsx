import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { PolicyPage } from './PolicyPage';

const POLICIES = {
  policies: [{ policyId: 'compact', title: 'Compact', description: '', isDefault: true }],
  active: { policyId: 'compact', version: 1, changedAt: 1_789_460_000 },
};

const PLAN = {
  mode: 'auto',
  modeVersion: 1,
  plan: null,
  appliedResult: { resultId: 'r', inputHash: 'hash-1', routerContextVersion: 'ctx-1' },
  lastResult: null,
};

function metrics(over: Record<string, number | null> = {}) {
  return {
    requestsTotal: 66,
    assignedCount: 60,
    unassignedCount: 6,
    urgentTotal: 13,
    urgentAssignedCount: 12,
    engineersUsed: 11,
    distanceKm: 90,
    travelTimeSec: 36_000,
    workTimeSec: 250_000,
    waitingTimeSec: 4_200,
    lunchTimeSec: 0,
    lateAssignedCount: 2,
    totalLatenessSec: 1_200,
    minWindowSlackSec: 600,
    workloadSpreadSec: 3_600,
    maxWorkloadSec: 30_000,
    ...over,
  };
}

const COMPARISON = {
  inputPublicationId: 'pub-7',
  inputHash: 'hash-1',
  routerContextVersion: 'ctx-1',
  computedAt: 1_789_460_000,
  searchBudgetMs: 8000,
  rows: [
    {
      strategyId: 'compact',
      kind: 'policy',
      isUsable: true,
      calculationMs: 740,
      metrics: metrics({ totalLatenessSec: 900 }),
    },
    {
      strategyId: 'baseline',
      kind: 'baseline',
      isUsable: true,
      calculationMs: 60,
      metrics: metrics({ assignedCount: 50, unassignedCount: 16 }),
    },
  ],
};

describe('PolicyPage', () => {
  beforeEach(() => {
    useSessionStore.setState({
      session: { token: 't', role: 'dispatcher', expiresAt: 4_102_444_800, email: 'd@e.test' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.setState({ session: null });
  });

  it('does not run the comparison until it is asked for', async () => {
    const fetchMock = stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/plan': () => jsonResponse(PLAN),
      '/dispatch/policy-comparison': () => jsonResponse(COMPARISON),
    });
    renderWithProviders(<PolicyPage />);

    await screen.findByText(/Запустите сравнение/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/policy-comparison'))).toBe(
      false,
    );
  });

  it('puts the baseline first and marks the active policy', async () => {
    const user = userEvent.setup();
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/plan': () => jsonResponse(PLAN),
      '/dispatch/policy-comparison': () => jsonResponse(COMPARISON),
    });
    renderWithProviders(<PolicyPage />);

    await user.click(await screen.findByRole('button', { name: 'Сравнить' }));
    const rows = await screen.findAllByRole('row');

    // Row 0 is the header.
    expect(within(rows[1] as HTMLElement).getByText('Базовая из ТЗ')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('сравнение с ТЗ')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('активная')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('60/66')).toBeInTheDocument();
    // 900 s of lateness against the baseline's 1200 s.
    expect(within(rows[2] as HTMLElement).getByText('-25% к FIFO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Пересчитать' })).toBeInTheDocument();
  });

  it('says the numbers are stale once the plan has moved on', async () => {
    const user = userEvent.setup();
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/plan': () =>
        jsonResponse({ ...PLAN, appliedResult: { ...PLAN.appliedResult, inputHash: 'hash-2' } }),
      '/dispatch/policy-comparison': () => jsonResponse(COMPARISON),
    });
    renderWithProviders(<PolicyPage />);

    await user.click(await screen.findByRole('button', { name: 'Сравнить' }));

    expect(
      await screen.findByText('План уже изменился — пересчитайте сравнение'),
    ).toBeInTheDocument();
  });

  it('names the server failure with the id that finds it in the log', async () => {
    const user = userEvent.setup();
    stubApi({
      '/dispatch/policies': () => jsonResponse(POLICIES),
      '/dispatch/plan': () => jsonResponse(PLAN),
      '/dispatch/policy-comparison': () =>
        jsonResponse(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal error',
              details: {},
              requestId: 'req-9',
            },
          },
          500,
        ),
    });
    renderWithProviders(<PolicyPage />);

    await user.click(await screen.findByRole('button', { name: 'Сравнить' }));

    expect(await screen.findByText(/INTERNAL_ERROR, requestId req-9/)).toBeInTheDocument();
  });
});
