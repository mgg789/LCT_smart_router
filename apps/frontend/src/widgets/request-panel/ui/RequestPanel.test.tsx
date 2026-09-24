import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { useSessionStore } from '@/entities/session';
import { renderWithProviders } from '@/test/renderWithProviders';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { RequestPanel, type RequestPanelProps } from './RequestPanel';

const request: RequestView = {
  id: 'job-2',
  version: 1,
  lifecycle: 'submitted',
  assignmentState: 'assigned',
  addressText: 'Тестовая улица, 2',
  region: 'east',
  lat: 55.7,
  lon: 37.6,
  needsGeocoding: false,
  geocodeQuality: 'verified',
  workType: 'local',
  workTypeTitle: 'Проверка',
  requiredSkill: 'local',
  requiredEquipment: null,
  normProfileCode: null,
  normativeTravelDurationSec: null,
  technicalDurationSec: null,
  documentationDurationSec: null,
  serviceDurationSec: 600,
  actualDurationSec: null,
  durationVarianceSec: null,
  windowStartAt: 1000,
  windowEndAt: 4000,
  priority: 'normal',
  contactName: null,
  problemText: null,
  createdAt: 500,
  submittedAt: 600,
  startedAt: null,
  expectedCompletionAt: null,
  continuationAvailableAt: null,
  overrunDetectedAt: null,
  completedAt: null,
  cancelledAt: null,
};

const route: PlanRouteView = {
  engineerId: 'engineer-1',
  startLat: 55.7,
  startLon: 37.6,
  startAt: 1000,
  finishAt: 3000,
  distanceKm: 3,
  travelTimeSec: 300,
  workTimeSec: 1200,
  waitingTimeSec: 0,
  lunchTimeSec: 0,
  assignedCount: 2,
  lunchStatus: 'disabled',
  stops: [
    {
      sequence: 0,
      kind: 'job',
      requestId: 'job-1',
      lat: 55.7,
      lon: 37.6,
      arrivalAt: 1100,
      startAt: 1200,
      endAt: 1800,
    },
    {
      sequence: 1,
      kind: 'job',
      requestId: 'job-2',
      lat: 55.7,
      lon: 37.6,
      arrivalAt: 1900,
      startAt: 2000,
      endAt: 2600,
    },
  ],
};

const engineer: EngineerView = {
  id: 'engineer-2',
  version: 1,
  displayName: 'Другой инженер',
  inputOrder: 2,
  skills: ['local'],
  transportType: 'car',
  region: 'east',
  homeLat: 55.7,
  homeLon: 37.6,
  hasAccount: true,
  email: 'engineer2@local.test',
  day: null,
};

function showPanel(overrides: Partial<RequestPanelProps> = {}) {
  renderWithProviders(
    <RequestPanel
      assignment={{ requestId: 'job-2', status: 'assigned', engineerId: 'engineer-1', reasons: [] }}
      editableRequestIds={['job-1', 'job-2']}
      engineer={null}
      engineers={[engineer]}
      mode="manual"
      modeVersion={5}
      planRevision={3}
      request={request}
      route={route}
      {...overrides}
    />,
  );
}

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

describe('MANUAL request controls', () => {
  it('sends assisted intentions through preview instead of legacy manual writes', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({});
    const onChange = vi.fn();
    showPanel({
      mode: 'assisted',
      assistedEditable: true,
      onAssistedChange: onChange,
      pinnedEngineerId: 'engineer-1',
    });
    await user.click(await screen.findByRole('button', { name: 'Переместить раньше' }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'reorder',
      engineerId: 'engineer-1',
      requestIds: ['job-2', 'job-1'],
    });
    await user.click(screen.getByRole('button', { name: 'Сменить пользователя' }));
    await user.click(screen.getByRole('button', { name: /Другой инженер/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'assign',
      requestId: 'job-2',
      engineerId: 'engineer-2',
    });
    await user.click(screen.getByRole('button', { name: 'Снять закрепление' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'release', requestIds: ['job-2'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a retained pin in AUTO but requires an editing reason before releasing it', async () => {
    showPanel({ mode: 'auto', pinnedEngineerId: 'engineer-1' });
    expect(await screen.findByRole('button', { name: 'Снять закрепление' })).toBeDisabled();
  });

  it('sends the complete editable queue and version guards when moving a job earlier', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({ '/dispatch/plan/reorder': () => jsonResponse({ applied: true }) });
    showPanel();

    await user.click(await screen.findByRole('button', { name: 'Переместить раньше' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith('/dispatch/plan/reorder'),
      );
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        engineerId: 'engineer-1',
        requestIds: ['job-2', 'job-1'],
        expectedModeVersion: 5,
        expectedPlanRevision: 3,
      });
    });
  });

  it('passes the same version guards when reassigning a job', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({ '/dispatch/plan/reassign': () => jsonResponse({ applied: true }) });
    showPanel();

    await user.click(await screen.findByRole('button', { name: 'Сменить пользователя' }));
    await user.click(await screen.findByRole('button', { name: /Другой инженер/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith('/dispatch/plan/reassign'),
      );
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        engineerId: 'engineer-2',
        requestId: 'job-2',
        expectedModeVersion: 5,
        expectedPlanRevision: 3,
      });
    });
  });

  it('can assign unstarted work in MANUAL before Router has produced a first plan', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({ '/dispatch/plan/reassign': () => jsonResponse({ applied: true }) });
    renderWithProviders(
      <RequestPanel
        assignment={null}
        editableRequestIds={[]}
        engineer={null}
        engineers={[engineer]}
        mode="manual"
        modeVersion={2}
        planRevision={0}
        request={{ ...request, assignmentState: 'unassigned' }}
        route={null}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Сменить пользователя' }));
    await user.click(await screen.findByRole('button', { name: /Другой инженер/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith('/dispatch/plan/reassign'),
      );
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        expectedModeVersion: 2,
        expectedPlanRevision: 0,
      });
    });
  });
});
