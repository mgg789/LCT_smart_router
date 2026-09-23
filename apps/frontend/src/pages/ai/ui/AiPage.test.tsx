import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@/features/ai/ask-assistant';
import { useConversation } from '@/features/ai/ask-assistant';
import { renderWithProviders } from '@/test/renderWithProviders';
import { AiPage } from './AiPage';

afterEach(() => useConversation.setState({ messages: [], runId: null, mode: 'ai', quota: null }));

function answer(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a1',
    role: 'assistant',
    questionId: 'u1',
    text: 'Заявку не назначили: в зоне нет нужного навыка.',
    actions: [],
    cards: [],
    notes: [],
    streaming: false,
    thoughtSec: 4,
    failure: null,
    rating: null,
    explain: null,
    ...overrides,
  };
}

/**
 * The thread is seeded straight into the store rather than typed in. Typing would
 * start a real run against the System Layer, which these tests neither have nor
 * want to assert about — what the screen does with a run's result is the subject
 * here, and `foldRunEvent.test.ts` covers how that result is built.
 */
function thread(...messages: Message[]) {
  useConversation.setState({
    messages: [{ id: 'u1', role: 'user', text: 'Почему заявку не назначили?' }, ...messages],
  });
}

describe('AiPage', () => {
  it('greets first and keeps the send button off until there is a question', () => {
    renderWithProviders(<AiPage />);

    expect(screen.getByRole('heading', { name: 'С чего начнём сегодня?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('shows the question and the answer, and says how long the run took', async () => {
    thread(answer());
    renderWithProviders(<AiPage />);

    expect(screen.getByText('Почему заявку не назначили?')).toBeInTheDocument();
    expect(await screen.findByText('Думал 4 секунд')).toBeInTheDocument();
    // The answer arrives word by word, so it is read as a whole paragraph.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          (element.textContent ?? '').includes('в зоне нет нужного навыка'),
      ),
    ).toBeInTheDocument();
  });

  it('says it is thinking while the run is still open', () => {
    thread(answer({ text: 'Смотрю', streaming: true, thoughtSec: null }));
    renderWithProviders(<AiPage />);

    expect(screen.getByText('Думает')).toBeInTheDocument();
    expect(screen.queryByText(/Думал/)).not.toBeInTheDocument();
  });

  it('offers «Остановить» only while a run is open', () => {
    thread(answer({ streaming: true, thoughtSec: null }));
    useConversation.setState({ runId: 'run-1' });
    renderWithProviders(<AiPage />);

    expect(screen.getByRole('button', { name: 'Остановить' })).toBeInTheDocument();
  });

  it('shows a failure the stream reported instead of an empty answer', () => {
    thread(answer({ text: null, failure: 'Модель недоступна (AI_PROVIDER_UNAVAILABLE)' }));
    renderWithProviders(<AiPage />);

    expect(screen.getByText('Модель недоступна (AI_PROVIDER_UNAVAILABLE)')).toBeInTheDocument();
  });

  it('draws the server’s buttons and never invents one', () => {
    thread(
      answer({
        actions: [
          { kind: 'confirm_operation', label: 'Подтвердить перенос', operationId: 'op-1' },
          { kind: 'cancel_operation', label: 'Отменить', operationId: 'op-1' },
        ],
      }),
    );
    renderWithProviders(<AiPage />);

    expect(screen.getByRole('button', { name: 'Подтвердить перенос' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument();
  });

  it('never reads an unknown outcome as cancelled or as done', () => {
    thread(
      answer({
        cards: [
          {
            operationId: 'op-1',
            action: 'request.move_window',
            state: 'outcome_unknown',
            preview: [{ label: 'Окно', value: '14:00–15:00' }],
            error: null,
          },
        ],
      }),
    );
    renderWithProviders(<AiPage />);

    expect(screen.getByText('Исход неизвестен — проверьте объект напрямую')).toBeInTheDocument();
    expect(screen.queryByText('Отменено до применения — записи не было')).not.toBeInTheDocument();
    expect(screen.queryByText('Выполнено')).not.toBeInTheDocument();
  });

  it('keeps the rating on the screen and lets it be taken back', async () => {
    const user = userEvent.setup();
    thread(answer());
    renderWithProviders(<AiPage />);

    const up = await screen.findByRole('button', { name: 'Хороший ответ' });
    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'true');

    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'false');
  });

  it('puts a question back into the field to be edited', async () => {
    const user = userEvent.setup();
    thread(answer());
    renderWithProviders(<AiPage />);

    await user.click(await screen.findByRole('button', { name: 'Изменить вопрос' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Вопрос ассистенту')).toHaveValue('Почему заявку не назначили?'),
    );
  });
});
