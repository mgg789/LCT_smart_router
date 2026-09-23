import type { EngineerView } from '@/entities/engineer';
import type { DispatchLiveView, LineStatus } from '@/entities/live';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { formatRange } from '@/shared/lib';

export type ContactKind = 'engineers' | 'clients';

export interface Contact {
  id: string;
  kind: ContactKind;
  name: string;
  /**
   * The line under the name. The drawing shows the last message there; there
   * are no messages, so it states what is known about the person instead.
   */
  status: string;
  /** Whether the person is reachable right now — the green «В сети». */
  online: boolean;
}

const LINE_STATUS: Record<LineStatus, string> = {
  online: 'В сети',
  pending: 'Ещё не на линии',
  no_show_offline: 'Не вышел на линию',
  technical_break: 'Техперерыв',
};

function shortNumber(requestId: string): string {
  return `№ ${requestId.slice(0, 8)}`;
}

/**
 * The crews, each with what the LIVE day says about them and the request they
 * are on — the one started, or else the next in their route.
 */
export function engineerContacts(
  engineers: EngineerView[],
  live: DispatchLiveView | null,
  plan: PlanView | null,
): Contact[] {
  const stateById = new Map(live?.engineers.map((state) => [state.id, state]) ?? []);
  const routeById = new Map(plan?.routes.map((route) => [route.engineerId, route]) ?? []);

  return engineers.map((engineer) => {
    const state = stateById.get(engineer.id);
    const next = routeById.get(engineer.id)?.stops.find((stop) => stop.kind === 'job')?.requestId;
    const requestId = state?.activeRequestId ?? next ?? null;
    const line = state ? LINE_STATUS[state.lineStatus] : 'Статус неизвестен';
    return {
      id: engineer.id,
      kind: 'engineers',
      name: engineer.displayName,
      status: requestId ? `${line} · заявка ${shortNumber(requestId)}` : line,
      online: state?.lineStatus === 'online',
    };
  });
}

/**
 * The clients of the day, once each, with their nearest request.
 *
 * A client is named as the request names them. The official dataset leaves
 * `contactName` empty on every request, so there the address is the only
 * identity a client has, and it is what the list shows — the same person at
 * the same door is one entry.
 */
export function clientContacts(requests: RequestView[]): Contact[] {
  const byName = new Map<string, RequestView>();
  for (const request of requests) {
    const name = (request.contactName ?? request.addressText)?.trim();
    if (!name || request.lifecycle === 'cancelled') continue;
    const known = byName.get(name);
    if (!known || request.windowStartAt < known.windowStartAt) byName.set(name, request);
  }

  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'ru'))
    .map(([name, request]) => ({
      id: `client:${name}`,
      kind: 'clients' as const,
      name,
      status: `Заявка ${shortNumber(request.id)} · ${formatRange(request.windowStartAt, request.windowEndAt)}`,
      online: false,
    }));
}

/** Case-insensitive search over names. */
export function filterContacts(contacts: Contact[], query: string): Contact[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? contacts.filter((contact) => contact.name.toLowerCase().includes(needle))
    : contacts;
}
