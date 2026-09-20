import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type ClientAssistantChatLike,
  ClientAssistantTab,
  ClientRequestForm,
  ClientRequestsList,
  emptyClientDraft,
  hrefForClientTab,
  parseClientPath,
} from './ClientApp';

describe('/client route parsing', () => {
  it('resolves each tab from the pathname', () => {
    expect(parseClientPath('/client')).toBe('requests');
    expect(parseClientPath('/client/')).toBe('requests');
    expect(parseClientPath('/client/new')).toBe('new');
    expect(parseClientPath('/client/assistant')).toBe('assistant');
    expect(parseClientPath('/client/unknown')).toBe('requests');
  });

  it('builds the href back for each tab', () => {
    expect(hrefForClientTab('requests')).toBe('/client');
    expect(hrefForClientTab('new')).toBe('/client/new');
    expect(hrefForClientTab('assistant')).toBe('/client/assistant');
  });
});

describe('client requests list states', () => {
  const base = {
    requests: [],
    onReload: () => {},
    onReschedule: () => {},
    onCancel: () => {},
    busyId: null,
    actionError: null,
  };

  it('shows the offline state ahead of everything else', () => {
    const html = renderToStaticMarkup(
      createElement(ClientRequestsList, { ...base, loading: true, error: null, offline: true }),
    );
    expect(html).toContain('Нет связи с сетью');
  });

  it('shows a loading state', () => {
    const html = renderToStaticMarkup(
      createElement(ClientRequestsList, { ...base, loading: true, error: null, offline: false }),
    );
    expect(html).toContain('Загружаем заявки');
  });

  it('shows an empty state once loaded with nothing to show', () => {
    const html = renderToStaticMarkup(
      createElement(ClientRequestsList, { ...base, loading: false, error: null, offline: false }),
    );
    expect(html).toContain('Активных заявок пока нет');
  });

  it('shows an error state with a retry action', () => {
    const html = renderToStaticMarkup(
      createElement(ClientRequestsList, {
        ...base,
        loading: false,
        error: 'Сеть недоступна',
        offline: false,
      }),
    );
    expect(html).toContain('Сеть недоступна');
    expect(html).toContain('Повторить');
  });
});

describe('client assistant tab: the required plain-form fallback', () => {
  const fakeChat: ClientAssistantChatLike = {
    messages: [],
    operations: new Map(),
    handoffStatus: null,
    activity: null,
    loading: false,
    sending: false,
    error: null,
    unavailable: 'provider',
    quota: null,
    runState: null,
    sendMessage: async () => {},
    stop: async () => {},
    applyOperation: async () => {},
    cancelOperation: async () => {},
  };

  const form = createElement(ClientRequestForm, {
    workTypes: [{ code: 'internet', title: 'Интернет' }],
    value: emptyClientDraft(),
    onChange: () => {},
    onSubmit: () => {},
    submitting: false,
    error: null,
    success: null,
  });

  it('renders the fallback form when the assistant reports unavailable', () => {
    const html = renderToStaticMarkup(
      createElement(ClientAssistantTab, { chat: fakeChat, fallbackForm: form }),
    );
    expect(html).toContain('AI сейчас недоступен');
    expect(html).toContain('Ассистент сейчас недоступен');
    expect(html).toContain('Контактное лицо');
    expect(html).toContain('Тип работ');
    expect(html).toContain('Отправить заявку');
  });

  it('keeps the same form reachable (collapsed) when the assistant is fine -- it is an alternative, not a fallback gated behind failure', () => {
    const html = renderToStaticMarkup(
      createElement(ClientAssistantTab, {
        chat: { ...fakeChat, unavailable: null },
        fallbackForm: form,
      }),
    );
    expect(html).toContain('Оформить заявку без ассистента');
    expect(html).toContain('Контактное лицо');
  });
});
