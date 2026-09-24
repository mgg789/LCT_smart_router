import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiOperationView, AssistantChatMessage } from '../../hooks/useAssistantChat';
import { ChatMessage } from './ChatMessage';

function baseMessage(overrides: Partial<AssistantChatMessage>): AssistantChatMessage {
  return {
    id: 'm1',
    seq: 1,
    author: 'assistant',
    kind: 'text',
    text: 'Привет',
    actions: [],
    createdAt: 1000,
    pending: false,
    ...overrides,
  };
}

function render(
  message: AssistantChatMessage,
  operations: ReadonlyMap<string, AiOperationView> = new Map(),
) {
  return renderToStaticMarkup(
    createElement(ChatMessage, {
      message,
      operations,
      onApplyOperation: () => {},
      onCancelOperation: () => {},
    }),
  );
}

describe('ChatMessage', () => {
  it('renders a plain text message as paragraphs with no controls', () => {
    const html = render(baseMessage({ kind: 'text', text: 'Первая строка\nВторая строка' }));
    expect(html).toContain('Первая строка');
    expect(html).toContain('Вторая строка');
    expect(html).not.toContain('<button');
    expect(html).toContain('Ассистент');
  });

  it('escapes markup inside text instead of rendering it as HTML', () => {
    const html = render(
      baseMessage({ kind: 'text', text: '<b>жирный</b> <script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<b>жирный</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('renders one primary pill for text_action', () => {
    const html = render(
      baseMessage({
        kind: 'text_action',
        text: 'Продолжить?',
        actions: [{ kind: 'confirm_operation', label: 'Продолжить', operationId: 'op-1' }],
      }),
    );
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(1);
    expect(html).toContain('Продолжить');
  });

  it('renders a primary and a ghost «Отменить» for text_action_cancel', () => {
    const html = render(
      baseMessage({
        kind: 'text_action_cancel',
        text: 'Подтвердите действие',
        actions: [
          { kind: 'confirm_operation', label: 'Подтвердить', operationId: 'op-2' },
          { kind: 'cancel_operation', label: 'Отменить', operationId: 'op-2' },
        ],
      }),
    );
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(2);
    expect(html).toContain('Подтвердить');
    expect(html).toContain('Отменить');
  });

  it('delegates text_confirmation to the operation card with its preview and actions', () => {
    const operations = new Map<string, AiOperationView>([
      [
        'op-3',
        {
          operationId: 'op-3',
          action: 'request.submit',
          targetRef: 'request/1',
          state: 'awaiting_confirmation',
          preview: [{ label: 'Адрес', value: 'ул. Ленина, 1' }],
          expiresAt: 2000,
        },
      ],
    ]);
    const html = render(
      baseMessage({
        kind: 'text_confirmation',
        text: 'Подтвердите заявку',
        actions: [
          { kind: 'confirm_operation', label: 'Применить', operationId: 'op-3' },
          { kind: 'cancel_operation', label: 'Отменить', operationId: 'op-3' },
        ],
      }),
      operations,
    );
    expect(html).toContain('ул. Ленина, 1');
    expect(html).toContain('Применить');
    expect(html).toContain('Отменить');
    expect(html).toContain('Ждёт подтверждения');
  });

  it('renders outcome_unknown as honest uncertainty, never as cancelled or applied', () => {
    const operations = new Map<string, AiOperationView>([
      [
        'op-4',
        {
          operationId: 'op-4',
          action: 'request.submit',
          targetRef: null,
          state: 'outcome_unknown',
          preview: [],
          expiresAt: 0,
        },
      ],
    ]);
    const html = render(
      baseMessage({
        kind: 'text_confirmation',
        text: 'Результат неизвестен из-за сбоя связи',
        actions: [{ kind: 'confirm_operation', label: 'Применить', operationId: 'op-4' }],
      }),
      operations,
    );
    expect(html).not.toContain('Отменено');
    expect(html).not.toContain('Применено');
    expect(html).toContain('Результат неизвестен');
    // Not decidable anymore: no action buttons once the outcome is unresolved.
    expect(html).not.toContain('<button');
  });

  it('shows explicit dispatcher authorship', () => {
    const html = render(baseMessage({ author: 'dispatcher', text: 'Уже еду' }));
    expect(html).toContain('Диспетчер');
  });
});
