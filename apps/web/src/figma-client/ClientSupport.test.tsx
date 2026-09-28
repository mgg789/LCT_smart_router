import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HandoffBanner } from '../components/ai/PhoneAiPane';
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

/**
 * The banner is the only thing that tells a reader the assistant has stepped
 * aside. Silence while a handover is pending reads as a stalled assistant, so
 * `waiting` has to say something too, not just `answered`.
 */
it('names who holds the dialogue, and draws nothing while the assistant holds it', () => {
  expect(renderToStaticMarkup(<HandoffBanner status="waiting" />)).toContain('Передали диспетчеру');
  expect(renderToStaticMarkup(<HandoffBanner status="answered" />)).toContain('На связи диспетчер');
  expect(renderToStaticMarkup(<HandoffBanner status={null} />)).toBe('');
});
