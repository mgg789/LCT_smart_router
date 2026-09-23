import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistedProposal, AssistedState } from '@/entities/dispatcher-constraints';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { useAssistedCorrection } from '../model/useAssistedCorrection';
import { CorrectionReview } from './CorrectionReview';

function proposal(critical: boolean, fingerprint = 'a'): AssistedProposal {
  return {
    proposalId: 'proposal',
    previewFingerprint: fingerprint.repeat(64),
    source: 'dispatcher',
    state: 'prepared',
    createdAt: 100,
    expiresAt: 10000,
    canApply: true,
    requiresConfirmation: critical,
    versions: { expectedModeVersion: 4, expectedPlanRevision: 9, expectedConstraintsVersion: 2 },
    change: { kind: 'assign', requestId: 'r1', engineerId: 'e2' },
    constraints: { assignments: [{ requestId: 'r1', engineerId: 'e2' }], orders: [] },
    impact: {
      assignedBefore: 2,
      assignedAfter: critical ? 1 : 2,
      lost: critical ? [{ requestId: 'r2', engineerId: 'e1', priority: 'urgent' }] : [],
      moved: [{ requestId: 'r1', fromEngineerId: 'e1', toEngineerId: 'e2' }],
      reorderedRoutes: [],
      delayed: [],
      newlyLate: [],
      addedEngineerIds: [],
      timingsCompared: true,
      criticalReasons: critical ? [{ code: 'ASSIGNMENTS_LOST', entityIds: ['r2'] }] : [],
      requiresConfirmation: critical,
      fingerprint: 'c'.repeat(64),
    },
    blockers: [],
  };
}

const STATE: AssistedState = {
  mode: 'assisted',
  modeVersion: 4,
  planRevision: 9,
  constraintsVersion: 2,
  constraints: { assignments: [], orders: [] },
  pendingProposal: null,
  blockers: [],
  editableRequestIds: ['r1', 'r2'],
};

function Harness() {
  const flow = useAssistedCorrection();
  return (
    <>
      <button
        onClick={() => flow.change({ kind: 'assign', requestId: 'r1', engineerId: 'e2' })}
        disabled={flow.busy}
        type="button"
      >
        Назначить
      </button>
      <button
        onClick={() => {
          flow.change({ kind: 'assign', requestId: 'r1', engineerId: 'e2' });
          flow.change({ kind: 'assign', requestId: 'r1', engineerId: 'e2' });
        }}
        type="button"
      >
        Быстрый повтор
      </button>
      <button onClick={flow.reviewPending} type="button">
        Проверить авто-предложение
      </button>
      {flow.error ? <p role="alert">{flow.error}</p> : null}
      {flow.proposal ? (
        <CorrectionReview
          proposal={flow.proposal}
          requests={[]}
          engineers={[]}
          busy={flow.busy}
          error={flow.error}
          onConfirm={flow.confirm}
          onCancel={flow.cancel}
          onRecalculate={flow.recalculate}
        />
      ) : null}
    </>
  );
}

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

beforeEach(() => {
  useSessionStore.getState().signIn({
    token: 'tok',
    role: 'dispatcher',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    email: 'dispatcher@local.test',
  });
});
afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

describe('dispatcher correction review', () => {
  it('coalesces repeated gestures before the pending state renders', async () => {
    const candidate = proposal(false);
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(candidate),
      '/dispatch/assisted/apply': () =>
        jsonResponse({
          state: 'applied',
          proposalId: 'proposal',
          planRevision: 10,
          constraintsVersion: 3,
          impact: candidate.impact,
        }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Быстрый повтор' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/assisted/apply')),
      ).toHaveLength(1),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/assisted/preview')),
    ).toHaveLength(1);
  });
  it('applies an ordinary change only after server preview using the review fingerprint', async () => {
    const candidate = proposal(false);
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(candidate),
      '/dispatch/assisted/apply': () =>
        jsonResponse({
          state: 'applied',
          proposalId: candidate.proposalId,
          planRevision: 10,
          constraintsVersion: 3,
          impact: candidate.impact,
        }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Назначить' }));
    await waitFor(() => {
      const apply = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/assisted/apply'));
      expect(JSON.parse(String(apply?.[1]?.body ?? '{}'))).toMatchObject({
        proposalId: 'proposal',
        expectedPreviewFingerprint: 'a'.repeat(64),
        confirmCritical: false,
      });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not apply a critical proposal until the dispatcher explicitly confirms it', async () => {
    const candidate = proposal(true);
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(candidate),
      '/dispatch/assisted/apply': () =>
        jsonResponse({
          state: 'applied',
          proposalId: 'proposal',
          planRevision: 10,
          constraintsVersion: 3,
          impact: candidate.impact,
        }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Назначить' }));
    await screen.findByRole('dialog', { name: 'Проверьте последствия' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assisted/apply'))).toBe(
      false,
    );
    await user.click(screen.getByRole('button', { name: 'Подтвердить и применить' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/assisted/apply'));
      expect(JSON.parse(String(call?.[1]?.body ?? '{}')).confirmCritical).toBe(true);
    });
  });

  it('cancels a critical proposal without an apply request', async () => {
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(proposal(true)),
      '/dispatch/assisted/cancel': () =>
        jsonResponse({ proposalId: 'proposal', state: 'cancelled' }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Назначить' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Отменить изменение' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assisted/cancel'))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assisted/apply'))).toBe(
      false,
    );
  });

  it('requires another explicit confirmation when the server refreshes the review card', async () => {
    let attempts = 0;
    const changed = proposal(true, 'b');
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(proposal(true)),
      '/dispatch/assisted/apply': () => {
        attempts++;
        return attempts === 1
          ? jsonResponse(
              {
                error: {
                  code: 'CONFIRMATION_REQUIRED',
                  message: 'Changed',
                  details: { proposal: changed },
                },
              },
              409,
            )
          : jsonResponse({
              state: 'applied',
              proposalId: 'proposal',
              planRevision: 10,
              constraintsVersion: 3,
              impact: changed.impact,
            });
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Назначить' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Подтвердить и применить' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Подтвердить и применить' })).toBeEnabled(),
    );
    expect(attempts).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Подтвердить и применить' }));
    await waitFor(() => expect(attempts).toBe(2));
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/assisted/apply'));
    expect(JSON.parse(String(calls[1]?.[1]?.body ?? '{}')).expectedPreviewFingerprint).toBe(
      'b'.repeat(64),
    );
  });

  it('only offers a blocked candidate for review, never confirmation', async () => {
    const candidate = proposal(true);
    candidate.state = 'blocked';
    candidate.canApply = false;
    candidate.blockers = [
      {
        code: 'DISPATCHER_CONSTRAINT_CONFLICT',
        message: 'No feasible pins',
        requestIds: ['r1'],
        engineerIds: ['e2'],
      },
    ];
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse(STATE),
      '/dispatch/assisted/preview': () => jsonResponse(candidate),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Назначить' }));
    await screen.findByRole('dialog', { name: 'Изменение не удалось разместить' });
    expect(
      screen.queryByRole('button', { name: 'Подтвердить и применить' }),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assisted/apply'))).toBe(
      false,
    );
  });

  it('does not apply a background automatic proposal just by reading it', async () => {
    const pending = { ...proposal(true), source: 'automatic' as const };
    const fetchMock = stubApi({
      '/dispatch/assisted': () => jsonResponse({ ...STATE, pendingProposal: pending }),
    });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Проверить авто-предложение' }));
    await screen.findByRole('dialog');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assisted/apply'))).toBe(
      false,
    );
  });
});
