import { PhoneAiPane } from '../components/ai/PhoneAiPane';

/**
 * First-turn prompts for a customer: the three things someone opens support for
 * before they have a question of their own.
 */
export const CLIENT_QUICK_QUESTIONS = [
  'Когда приедет инженер?',
  'Нужно перенести визит',
  'Что подготовить к приходу?',
] as const;

/**
 * First name for the empty greeting; a profile without one stays unnamed rather
 * than being addressed by an email address.
 */
export function clientGreeting(contactName: string | null | undefined): string {
  const first = contactName?.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0) return 'Чем помочь?';
  return `${first}, чем помочь?`;
}

/**
 * The customer's «Поддержка» screen.
 *
 * The same dialogue the dispatcher's board writes into: the assistant answers
 * first and hands over when it cannot, and a dispatcher who opens a chat about
 * one of this customer's requests lands in this very thread. There is no second
 * inbox to check.
 */
export function ClientSupport({
  token,
  contactName,
}: {
  token: string | null;
  contactName: string | null;
}) {
  return (
    <PhoneAiPane
      token={token}
      surface="client"
      greeting={clientGreeting(contactName)}
      quickQuestions={CLIENT_QUICK_QUESTIONS}
      placeholder="Напишите нам..."
    />
  );
}
