import { useCallback, useEffect, useState } from 'react';
import {
  type DispatchChatView,
  finishDispatchChat,
  loadDispatchChats,
  readDispatchChat,
  sendDispatchChatMessage,
} from '../api/ai';
import { DashboardApiError } from '../api/client';
import { ChatsPage } from '../components/ChatsPage';
import { DashboardAi } from './DispatcherAiPane';

export { DashboardAi };

/** Dispatcher chat list for the sidebar tab. Reads the handover contour and writes replies. */
export function DashboardChats({ token }: { token: string | null }) {
  const [chats, setChats] = useState<DispatchChatView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!token) {
      setChats(null);
      setError('Нужна сессия диспетчера.');
      return;
    }
    setLoading(true);
    void loadDispatchChats(token)
      .then((result) => {
        setChats(result.chats);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof DashboardApiError ? cause.message : 'Не удалось загрузить чаты.');
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="absolute inset-0 overflow-auto bg-figma-canvas p-[32px]">
      <ChatsPage
        token={token}
        chats={chats}
        loading={loading}
        error={error}
        writesDisabled={!token}
        onRefresh={refresh}
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
      />
    </div>
  );
}
