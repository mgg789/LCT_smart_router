import { useCallback, useEffect, useState } from 'react';
import {
  type DispatchChatView,
  finishDispatchChat,
  loadDispatchChats,
  readDispatchChat,
  sendDispatchChatMessage,
} from '../api/ai';
import { DashboardApiError } from '../api/client';
import type { DashboardSnapshot } from '../api/types';
import { t } from '../i18n';
import { ChatsView } from './ChatsView';
import { DashboardAi } from './DispatcherAiPane';
import { engineerProfilesFromSnapshot } from './engineerRoster';

export { DashboardAi };

/** Dispatcher chat list for the sidebar tab. Reads the handover contour and writes replies. */
export function DashboardChats({
  token,
  focusChatId,
  focusEngineerId,
  snapshot,
  onOpenEngineer,
}: {
  token: string | null;
  focusChatId?: string | null;
  focusEngineerId?: string | null;
  snapshot: DashboardSnapshot | null;
  onOpenEngineer: (engineerId: string, text: string) => Promise<DispatchChatView>;
}) {
  const [chats, setChats] = useState<DispatchChatView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (quiet = false) => {
      if (!token) {
        setChats(null);
        setError(t('figma-dashboard.DashboardAssist.df8d670234'));
        return;
      }
      if (!quiet) setLoading(true);
      void loadDispatchChats(token)
        .then((result) => {
          setChats(result.chats);
          setError(null);
        })
        .catch((cause: unknown) => {
          setError(
            cause instanceof DashboardApiError
              ? cause.message
              : t('figma-dashboard.DashboardAssist.bb8e076789'),
          );
        })
        .finally(() => setLoading(false));
    },
    [token],
  );

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-figma-canvas">
      <ChatsView
        token={token}
        focusChatId={focusChatId}
        focusEngineerId={focusEngineerId}
        chats={chats}
        loading={loading}
        error={error}
        writesDisabled={!token}
        onSendMessage={async (conversationId, text) => {
          if (!token) return;
          await sendDispatchChatMessage(token, conversationId, crypto.randomUUID(), text);
          refresh();
        }}
        onFinish={async (conversationId) => {
          if (!token) return;
          await finishDispatchChat(token, conversationId, crypto.randomUUID());
          refresh();
        }}
        onMarkRead={(conversationId, seq) => {
          if (!token) return;
          void readDispatchChat(token, conversationId, crypto.randomUUID(), seq);
        }}
        engineers={engineerProfilesFromSnapshot(snapshot).map(
          ({ id, displayName, hasAccount }) => ({
            id,
            displayName,
            canChat: hasAccount,
          }),
        )}
        onOpenEngineer={async (engineerId, text) => {
          const chat = await onOpenEngineer(engineerId, text);
          setChats((current) => [
            chat,
            ...(current ?? []).filter((item) => item.handoff.id !== chat.handoff.id),
          ]);
          return chat;
        }}
      />
    </div>
  );
}
