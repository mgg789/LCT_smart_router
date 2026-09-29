import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TurnDivider } from '../components/ai/PhoneAiPane';
import { CLIENT_QUICK_QUESTIONS, clientGreeting } from './ClientSupport';

it('greets the customer by their first name and stays unnamed otherwise', () => {
  expect(clientGreeting('Иван Петров')).toBe('Иван, чем помочь?');
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
