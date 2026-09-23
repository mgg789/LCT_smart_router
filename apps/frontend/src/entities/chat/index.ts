export {
  finishChat,
  getDispatchChats,
  markChatRead,
  openDispatchChat,
  sendChatMessage,
  streamChatEvents,
} from './api/chats';
export type { AiHandoff, ChatStreamEvent, ChatTarget, DispatchChatView } from './model/types';
export { isClosed, isWaiting } from './model/types';
export {
  CHATS_POLL_MS,
  countWaiting,
  dispatchChatsQueryKey,
  useDispatchChats,
} from './model/useDispatchChats';
