import { PhoneAiPane } from '../components/ai/PhoneAiPane';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { t } from '../i18n';

/**
 * First-turn prompts for a customer: the three things someone opens support for
 * before they have a question of their own.
 */
export const CLIENT_QUICK_QUESTIONS = [
  t('figma-client.ClientSupport.16f0d00829'),
  t('figma-client.ClientSupport.98e172ef68'),
  t('figma-client.ClientSupport.a43166ade1'),
] as const;

/**
 * Given name for the empty greeting; a profile without one stays unnamed rather
 * than being addressed by an email address.
 *
 * Customers write their contact as «Фамилия Имя Отчество», which is what the request
 * form asks for, so the first word is the surname: taking it greeted «Петров, чем
 * помочь?». Three words are read as full Russian name order and the second is the
 * given name; anything else keeps its first word, which is right for «Иван» and for
 * «Иван Петров» alike.
 */
export function clientGreeting(contactName: string | null | undefined): string {
  const words = contactName?.trim().split(/\s+/).filter(Boolean) ?? [];
  const first = (words.length === 3 ? words[1] : words[0]) ?? '';
  if (first.length === 0) return t('figma-client.ClientSupport.489aa65e96');
  return t('figma-client.ClientSupport.9984d8a660', { value0: first });
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
  sessionScope,
  onSessionExpired,
  onOperationApplied,
  onOpenRequest,
}: {
  token: string | null;
  contactName: string | null;
  sessionScope: string;
  onSessionExpired: () => void;
  onOperationApplied: () => void;
  onOpenRequest: (id: string) => void;
}) {
  return (
    <PhoneAiPane
      token={token}
      surface="client"
      sessionScope={sessionScope}
      onSessionExpired={onSessionExpired}
      onOperationApplied={onOperationApplied}
      onOpenObject={(target) => {
        if (target.type === 'request') onOpenRequest(target.id);
      }}
      greeting={clientGreeting(contactName)}
      quickQuestions={CLIENT_QUICK_QUESTIONS}
      avatar={FIGMA_ASSETS.aiKolobokClient}
      placeholder={t('figma-client.ClientSupport.8105e6c36e')}
    />
  );
}
