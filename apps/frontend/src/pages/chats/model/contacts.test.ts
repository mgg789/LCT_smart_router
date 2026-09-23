import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { DispatchLiveView, LiveEngineerState } from '@/entities/live';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { clientContacts, engineerContacts, filterContacts } from './contacts';

const engineer = (id: string, name: string) => ({ id, displayName: name }) as EngineerView;

function state(id: string, over: Partial<LiveEngineerState> = {}): LiveEngineerState {
  return {
    id,
    name: '',
    lineStatus: 'online',
    lineStartedAt: 1,
    activeRequestId: null,
    routeState: 'active',
    stats: {
      completedCount: 0,
      cancelledCount: 0,
      assumedCompletedCount: 0,
      problemCount: 0,
      technicalBreakCount: 0,
    },
    ...over,
  };
}

const live = (engineers: LiveEngineerState[]) =>
  ({ engineers, history: [] }) as unknown as DispatchLiveView;

const plan = {
  routes: [
    {
      engineerId: 'e2',
      stops: [
        { kind: 'wait', requestId: null },
        { kind: 'job', requestId: 'b1c2d3e4-next' },
      ],
    },
  ],
} as unknown as PlanView;

describe('engineerContacts', () => {
  it('says whether the crew is on the line and which request it is on', () => {
    const [crew] = engineerContacts(
      [engineer('e1', 'Бригада Соколов')],
      live([state('e1', { activeRequestId: 'a1b2c3d4-now' })]),
      null,
    );

    expect(crew).toMatchObject({ status: 'В сети · заявка № a1b2c3d4', online: true });
  });

  it('falls back to the next visit in the route', () => {
    const [crew] = engineerContacts([engineer('e2', 'Бригада Попов')], live([state('e2')]), plan);

    expect(crew?.status).toBe('В сети · заявка № b1c2d3e4');
  });

  it('does not call a crew reachable that never went on the line', () => {
    const [crew] = engineerContacts(
      [engineer('e3', 'Бригада Зверев')],
      live([state('e3', { lineStatus: 'no_show_offline' })]),
      null,
    );

    expect(crew).toMatchObject({ status: 'Не вышел на линию', online: false });
  });
});

describe('clientContacts', () => {
  const request = (
    id: string,
    name: string | null,
    start: number,
    over: Partial<RequestView> = {},
  ) =>
    ({
      id,
      contactName: name,
      lifecycle: 'submitted',
      windowStartAt: start,
      windowEndAt: start + 7200,
      ...over,
    }) as RequestView;

  it('lists each client once, by their nearest request, and drops the cancelled', () => {
    const clients = clientContacts([
      request('r-late-0000', 'Иван Петров', 2_000_000_000),
      request('r-soon-0000', 'Иван Петров', 1_000_000_000),
      request('r-gone-0000', 'Анна', 1_000_000_000, { lifecycle: 'cancelled' }),
    ]);

    expect(clients.map((client) => client.name)).toEqual(['Иван Петров']);
    expect(clients[0]?.status).toMatch(/^Заявка № r-soon-0 · /);
  });

  it('knows a nameless client by the address, as the dataset gives it', () => {
    const clients = clientContacts([
      request('r-anon-0000', null, 1_000_000_000, { addressText: 'Москва, ул. Лесная, 7' }),
    ]);

    expect(clients[0]?.name).toBe('Москва, ул. Лесная, 7');
  });
});

describe('filterContacts', () => {
  it('finds by any part of the name, ignoring case', () => {
    const contacts = engineerContacts(
      [engineer('e1', 'Бригада Соколов'), engineer('e2', 'Бригада Попов')],
      null,
      null,
    );
    expect(filterContacts(contacts, 'соко').map((contact) => contact.id)).toEqual(['e1']);
  });
});
