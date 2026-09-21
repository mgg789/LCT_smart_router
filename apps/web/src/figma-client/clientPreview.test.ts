import { expect, it } from 'vitest';
import {
  canSubmitClientForm,
  CLIENT_PREVIEW_REQUESTS,
  EMPTY_CLIENT_DRAFT,
  nextClientRequestNumber,
  requestFromDraft,
  splitClientRequests,
} from './clientPreview';

it('features the en-route card and keeps the two Figma archive rows', () => {
  const split = splitClientRequests(CLIENT_PREVIEW_REQUESTS);
  expect(split.featured?.number).toBe('1042');
  expect(split.rest).toHaveLength(0);
  expect(split.archive.map((item) => item.number)).toEqual(['1038', '1037']);
});

it('blocks send until address and email are filled', () => {
  expect(canSubmitClientForm(EMPTY_CLIENT_DRAFT)).toBe(false);
  expect(
    canSubmitClientForm({
      ...EMPTY_CLIENT_DRAFT,
      address: 'ул. Лесная, 7',
      email: 'ivanfromgorizont@gmail.com',
    }),
  ).toBe(true);
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
