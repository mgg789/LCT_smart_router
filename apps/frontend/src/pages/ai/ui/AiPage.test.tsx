import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useConversation } from '@/features/ai/ask-assistant';
import { renderWithProviders } from '@/test/renderWithProviders';
import { AiPage } from './AiPage';

afterEach(() => useConversation.setState({ messages: [] }));

describe('AiPage', () => {
  it('greets first and keeps the send button off until there is a question', () => {
    renderWithProviders(<AiPage />);

    expect(screen.getByRole('heading', { name: 'С чего начнём сегодня?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('shows the question and says plainly that no assistant is connected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiPage />);

    await user.type(
      screen.getByLabelText('Вопрос ассистенту'),
      'Почему заявку не назначили?{Enter}',
    );

    expect(await screen.findByText('Почему заявку не назначили?')).toBeInTheDocument();
    expect(await screen.findByText('Ассистент не подключён')).toBeInTheDocument();
    expect(screen.getByText(/AI-ассистента в System Layer пока нет/)).toBeInTheDocument();
    // Nothing claims the model thought about it.
    expect(screen.queryByText(/Думал/)).not.toBeInTheDocument();
  });

  it('keeps the rating on the screen and lets it be taken back', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiPage />);
    await user.type(screen.getByLabelText('Вопрос ассистенту'), 'Как план против FIFO?{Enter}');

    const up = await screen.findByRole('button', { name: 'Хороший ответ' });
    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'true');

    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'false');
  });

  it('puts a question back into the field to be edited', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiPage />);
    await user.type(screen.getByLabelText('Вопрос ассистенту'), 'Первый вопрос{Enter}');

    await user.click(await screen.findByRole('button', { name: 'Изменить вопрос' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Вопрос ассистенту')).toHaveValue('Первый вопрос'),
    );
  });
});
