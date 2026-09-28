import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { type UseAssistantChatResult, useAssistantChat } from '../hooks/useAssistantChat';
import { ClientAiPane } from './ClientAiPane';
import { ClientMenu } from './ClientMenu';

vi.mock('../hooks/useAssistantChat', () => ({ useAssistantChat: vi.fn() }));
const noop = async () => {};
const base: UseAssistantChatResult = {
  conversation: null,
  messages: [],
  operations: new Map(),
  runState: null,
  quota: null,
  handoffStatus: null,
  activity: null,
  loading: false,
  sending: false,
  error: null,
  unavailable: null,
  sendMessage: noop,
  stop: noop,
  applyOperation: noop,
  cancelOperation: noop,
  setAssistMode: noop,
  clearConversation: noop,
};
const render = () =>
  renderToStaticMarkup(
    <ClientAiPane
      token="test-session"
      displayName="Анна"
      sessionScope="anna@example.test"
      onSessionExpired={() => {}}
      onOperationApplied={() => {}}
      onOpenRequest={() => {}}
    />,
  );
it('uses the client role and account cache scope with the original green mascot', () => {
  vi.mocked(useAssistantChat).mockReturnValue(base);
  const html = render();
  expect(useAssistantChat).toHaveBeenLastCalledWith({
    token: 'test-session',
    surface: 'client',
    sessionScope: 'anna@example.test',
  });
  expect(html).toContain('/figma/mascot-client-green.png');
  expect(html).not.toContain('ai-kolobok.png');
  expect(html).toContain('Покажи мои активные заявки');
});
it('keeps the client assistant local and disabled in the offline contour', () => {
  const runtime = globalThis as typeof globalThis & { window?: { navixOffline?: boolean } };
  const previousWindow = runtime.window;
  Object.defineProperty(runtime, 'window', {
    configurable: true,
    value: {
      navixOffline: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  try {
    vi.mocked(useAssistantChat).mockReturnValue(base);
    const html = render();
    expect(useAssistantChat).toHaveBeenLastCalledWith({
      token: null,
      surface: 'client',
      sessionScope: 'anna@example.test',
    });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Контур запущен в офлайн-режиме');
  } finally {
    if (previousWindow) {
      Object.defineProperty(runtime, 'window', { configurable: true, value: previousWindow });
    } else {
      Object.defineProperty(runtime, 'window', { configurable: true, value: undefined });
    }
  }
});
it('renders operation actions, errors and scroll room instead of hiding non-text responses', () => {
  vi.mocked(useAssistantChat).mockReturnValue({
    ...base,
    error: 'Сервис временно недоступен',
    messages: [
      {
        id: 'message',
        seq: 1,
        createdAt: 1,
        author: 'assistant',
        kind: 'text_action',
        text: 'Откройте вашу заявку',
        actions: [
          { kind: 'open_object', label: 'К заявке', target: { type: 'request', id: 'request' } },
        ],
        pending: false,
      },
    ],
  });
  const html = render();
  expect(html).toContain('К заявке');
  expect(html).toContain('data-chat-bottom-spacer');
  expect(html).toContain('Сервис временно недоступен');
});

it('makes the support entry reachable from the client menu', () => {
  const html = renderToStaticMarkup(
    <ClientMenu
      open
      motionOn={false}
      email={null}
      active="support"
      onClose={() => {}}
      onNavigate={() => {}}
      onNewRequest={() => {}}
    />,
  );
  expect(html).toContain('Поддержка');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain('aria-disabled="true"');
});
