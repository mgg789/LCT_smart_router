import { EngineerAiPane } from '../figma-engineer/EngineerAiPane';
import { t } from '../i18n';

/** Prompts reflect the real client tool catalogue, scoped to the signed-in account. */
export const CLIENT_QUICK_QUESTIONS = [
  t('figma-client.ClientAiPane.fa964a6cdc'),
  t('figma-client.ClientAiPane.1d44951b61'),
  t('figma-client.ClientAiPane.c06662b042'),
] as const;

/** Client-role conversations use existing sessions, operation previews and confirmation APIs. */
export function ClientAiPane({
  token,
  displayName,
  onOperationApplied,
  onOpenRequest,
  sessionScope,
  onSessionExpired,
}: {
  sessionScope: string;
  onSessionExpired: () => void;
  token: string;
  displayName: string | null;
  onOperationApplied: () => void;
  onOpenRequest: (id: string) => void;
}) {
  return (
    <EngineerAiPane
      token={token}
      displayName={displayName}
      surface="client"
      avatarSrc="/figma/mascot-client-green.png"
      sessionScope={sessionScope}
      onSessionExpired={onSessionExpired}
      quickQuestions={CLIENT_QUICK_QUESTIONS}
      onOperationApplied={onOperationApplied}
      onOpenObject={(target) => {
        if (target.type === 'request') onOpenRequest(target.id);
      }}
    />
  );
}
