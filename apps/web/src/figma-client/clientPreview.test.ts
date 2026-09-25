import { expect, it } from 'vitest';
import {
  CLIENT_PREVIEW_REQUESTS,
  canSubmitClientForm,
  clientPrepareBody,
  clientStatusLabel,
  clientSubmitHint,
  EMPTY_CLIENT_DRAFT,
  isActualClientRequest,
  nextClientRequestNumber,
  prefillClientDraft,
  requestFromDraft,
  splitClientRequests,
} from './clientPreview';

it('features the en-route card and keeps the two Figma archive rows', () => {
  const split = splitClientRequests(CLIENT_PREVIEW_REQUESTS);
  expect(split.featured?.number).toBe('1042');
  expect(split.rest).toHaveLength(0);
  expect(split.archive.map((item) => item.number)).toEqual(['1038', '1037']);
});

it('blocks send until name, address, map point and email are filled', () => {
  expect(canSubmitClientForm(EMPTY_CLIENT_DRAFT)).toBe(false);
  const ready = {
    ...EMPTY_CLIENT_DRAFT,
    contactName: 'Иван Иванов',
    address: 'ул. Лесная, 7',
    email: 'ivanfromgorizont@gmail.com',
    point: { lat: 55.78, lon: 37.59 },
  };
  expect(canSubmitClientForm(ready)).toBe(true);
  expect(canSubmitClientForm({ ...ready, point: null })).toBe(false);
  expect(clientSubmitHint({ ...ready, point: null })).toBe(
    'Отметьте точку на карте или выберите адрес из подсказок.',
  );
  expect(clientSubmitHint({ ...ready, email: 'не почта' })).toBe('Укажите почту.');
  expect(clientSubmitHint(ready)).toBeNull();
  const body = clientPrepareBody(ready, Date.parse('2026-09-15T09:00:00Z'));
  expect(body?.workType).toBe('no_link');
  expect(body?.contactName).toBe('Иван Иванов');
  expect(body?.lat).toBe(55.78);
});

it('keeps assigned, unassigned and in-progress on the actual list', () => {
  expect(isActualClientRequest({ lifecycle: 'submitted', assignmentState: 'assigned' })).toBe(true);
  expect(isActualClientRequest({ lifecycle: 'submitted', assignmentState: 'unassigned' })).toBe(
    true,
  );
  expect(isActualClientRequest({ lifecycle: 'submitted', assignmentState: 'pending' })).toBe(true);
  expect(isActualClientRequest({ lifecycle: 'in_progress', assignmentState: 'assigned' })).toBe(
    true,
  );
  expect(isActualClientRequest({ lifecycle: 'completed', assignmentState: 'assigned' })).toBe(
    false,
  );
  expect(isActualClientRequest({ lifecycle: 'cancelled', assignmentState: 'unassigned' })).toBe(
    false,
  );
  expect(clientStatusLabel({ lifecycle: 'submitted', assignmentState: 'pending' })).toBe(
    'Не назначена',
  );
  expect(clientStatusLabel({ lifecycle: 'in_progress', assignmentState: 'assigned' })).toBe(
    'В работе',
  );
});

it('prefills email always and name with address only after a sent request', () => {
  const blank = prefillClientDraft(EMPTY_CLIENT_DRAFT, {
    email: 'a@b.c',
    contactName: null,
    addressText: null,
    lat: null,
    lon: null,
  });
  expect(blank.email).toBe('a@b.c');
  expect(blank.contactName).toBe('');
  expect(blank.address).toBe('');
  const filled = prefillClientDraft(EMPTY_CLIENT_DRAFT, {
    email: 'a@b.c',
    contactName: 'Анна',
    addressText: 'ул. Лесная, 7',
    lat: 55.7,
    lon: 37.6,
  });
  expect(filled.contactName).toBe('Анна');
  expect(filled.address).toBe('ул. Лесная, 7');
  expect(filled.point).toEqual({ lat: 55.7, lon: 37.6 });
  const kept = prefillClientDraft(
    { ...EMPTY_CLIENT_DRAFT, address: 'свой адрес', contactName: 'Своё имя' },
    {
      email: 'a@b.c',
      contactName: 'Анна',
      addressText: 'ул. Лесная, 7',
      lat: 1,
      lon: 2,
    },
  );
  expect(kept.address).toBe('свой адрес');
  expect(kept.contactName).toBe('Своё имя');
});

it('keeps a picked map point on the submitted draft', () => {
  const number = nextClientRequestNumber(CLIENT_PREVIEW_REQUESTS);
  expect(number).toBe('1043');
  const created = requestFromDraft(
    {
      ...EMPTY_CLIENT_DRAFT,
      address: 'ул. Лесная, 7',
      email: 'ivanfromgorizont@gmail.com',
      point: { lat: 55.78, lon: 37.59 },
    },
    number,
    '2026-09-15',
  );
  expect(created.status).toBe('planned');
  expect(created.archived).toBe(false);
  expect(created.addressText).toBe('ул. Лесная, 7');
  expect(created.lat).toBe(55.78);
  expect(created.lon).toBe(37.59);
});
