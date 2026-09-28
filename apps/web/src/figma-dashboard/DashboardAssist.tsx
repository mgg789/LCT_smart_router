import { useCallback, useEffect, useState } from 'react';
import {
  type DispatchChatView,
  finishDispatchChat,
  loadDispatchChats,
  readDispatchChat,
  sendDispatchChatMessage,
} from '../api/ai';
import { DashboardApiError } from '../api/client';
import type { LiveWorkday } from '../api/live';
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
  snapshot,
  workday,
  onOpenEngineer,
}: {
  token: string | null;
  focusChatId?: string | null;
  snapshot: DashboardSnapshot | null;
  workday?: LiveWorkday | null;
  onOpenEngineer: (engineerId: string) => Promise<DispatchChatView>;
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

  /** Replaces one committed chat in place; a row the list has not seen yet is appended. */
  const applyChat = useCallback((chat: DispatchChatView) => {
    setChats((current) => {
      if (!current) return [chat];
      const known = current.some((item) => item.handoff.id === chat.handoff.id);
      return known
        ? current.map((item) => (item.handoff.id === chat.handoff.id ? chat : item))
        : [...current, chat];
    });
  }, []);

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
        chats={chats}
        loading={loading}
        error={error}
        writesDisabled={!token}
        onSendMessage={async (conversationId, text) => {
          if (!token) return;
          const written = await sendDispatchChatMessage(
            token,
            conversationId,
            crypto.randomUUID(),
            text,
          );
          // Show it the moment the server accepted it. Waiting for the five-second poll
          // left the composer empty and the thread unchanged, so the dispatcher could
          // not tell the message had gone and sent it a second time.
          applyChat(written.chat);
        }}
        onFinish={async (conversationId) => {
          if (!token) return;
          const finished = await finishDispatchChat(token, conversationId, crypto.randomUUID());
          applyChat(finished.chat);
        }}
        workday={workday ?? null}
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
        onOpenEngineer={async (engineerId) => {
          const chat = await onOpenEngineer(engineerId);
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
