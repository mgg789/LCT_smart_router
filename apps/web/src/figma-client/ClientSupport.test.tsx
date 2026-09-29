import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  handoffDividersAt,
  TurnDivider,
  trailingHandoffDividers,
} from '../components/ai/PhoneAiPane';
import { CLIENT_QUICK_QUESTIONS, clientGreeting } from './ClientSupport';

it('greets the customer by their first name and stays unnamed otherwise', () => {
  expect(clientGreeting('Иван Петров')).toBe('Иван, чем помочь?');
  // The request form asks for ФИО, so a full contact leads with the surname.
  expect(clientGreeting('Петров Иван Сергеевич')).toBe('Иван, чем помочь?');
  expect(clientGreeting('Иван')).toBe('Иван, чем помочь?');
  expect(clientGreeting(null)).toBe('Чем помочь?');
  expect(clientGreeting('   ')).toBe('Чем помочь?');
});

it('offers three first-turn questions a customer actually arrives with', () => {
  expect(CLIENT_QUICK_QUESTIONS).toEqual([
    'Когда приедет инженер?',
    'Нужно перенести визит',
    'Что подготовить к приходу?',
  ]);
});

/** A strip marks who takes the next lines. The assistant holding the chat draws nothing. */
it('names who holds the dialogue, and draws nothing while the assistant holds it', () => {
  expect(renderToStaticMarkup(<TurnDivider kind="dispatcher" />)).toContain('Передано диспетчеру');
  expect(renderToStaticMarkup(<TurnDivider kind="assistant" />)).toContain('Передано ассистенту');
  expect(renderToStaticMarkup(<TurnDivider kind={null} />)).toBe('');
});

/** The strip follows the handover itself, not the first line of the new speaker. */
it('draws the handover strip before anyone has written on the new side', () => {
  const open = { startSeq: 4, endSeq: null, open: true };
  const closed = { startSeq: 4, endSeq: 6, open: false };
  const before = [
    { author: 'user', seq: 1 },
    { author: 'assistant', seq: 2 },
  ];
  expect(trailingHandoffDividers(before, open)).toEqual(['dispatcher']);
  expect(handoffDividersAt([...before, { author: 'user', seq: 5 }], 2, open)).toEqual([
    'dispatcher',
  ]);
  expect(trailingHandoffDividers(before, closed)).toEqual(['dispatcher', 'assistant']);
  const handedBack = [...before, { author: 'dispatcher', seq: 5 }, { author: 'user', seq: 6 }];
  expect(trailingHandoffDividers(handedBack, closed)).toEqual(['assistant']);
  expect(handoffDividersAt([...handedBack, { author: 'assistant', seq: 7 }], 4, closed)).toEqual([
    'assistant',
  ]);
});
