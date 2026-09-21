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

it('blocks send until consent, address and email are filled', () => {
  expect(canSubmitClientForm(EMPTY_CLIENT_DRAFT)).toBe(false);
  expect(
    canSubmitClientForm({
      ...EMPTY_CLIENT_DRAFT,
      address: 'ул. Лесная, 7',
      email: 'ivanfromgorizont@gmail.com',
      consent: true,
    }),
  ).toBe(true);
});

it('numbers a submitted draft after the highest preview ticket', () => {
  const number = nextClientRequestNumber(CLIENT_PREVIEW_REQUESTS);
  expect(number).toBe('1043');
  const created = requestFromDraft(
    {
      ...EMPTY_CLIENT_DRAFT,
      address: 'ул. Лесная, 7',
      email: 'ivanfromgorizont@gmail.com',
      consent: true,
    },
    number,
    '2026-09-15',
  );
  expect(created.status).toBe('planned');
  expect(created.archived).toBe(false);
  expect(created.addressText).toBe('ул. Лесная, 7');
});
