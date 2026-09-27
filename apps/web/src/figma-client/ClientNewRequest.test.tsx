import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientNewRequest } from './ClientNewRequest';
import { draftFromStory, EMPTY_CLIENT_DRAFT } from './clientPreview';

it('supports the optional story mode with a mic and a send control', () => {
  const html = renderToStaticMarkup(
    <ClientNewRequest
      initialMode="story"
      draft={EMPTY_CLIENT_DRAFT}
      notice={null}
      onChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );
  expect(html).toContain('Расскажите, что у вас случилось');
  expect(html).toContain('Авто');
  expect(html).toContain('Форма');
  expect(html).toContain('Диктовка');
  expect(html).toContain('Отправить рассказ');
  expect(html).not.toContain('Заявка с AI');
  expect(html).not.toContain('подберём инженера');
});

it('renders the structured form without the old heading or the AI button', () => {
  const html = renderToStaticMarkup(
    <ClientNewRequest
      draft={EMPTY_CLIENT_DRAFT}
      notice={null}
      onChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );
  expect(html).toContain('ФИО');
  expect(html).toContain('Тип заявки');
  expect(html).not.toContain('Починить роутер');
  expect(html).not.toContain('Отправить рассказ');
  expect(html).toContain('Открыть карту');
  expect(html).not.toContain('Новая заявка');
  expect(html).not.toContain('Заявка с AI');
  expect(html).not.toContain('Указать на карте');
});

it('copies email, clocks and a name out of the free-text story', () => {
  const next = draftFromStory(
    'Меня зовут Иван Петров, интернет не работает, приедьте 11:00-13:00, ivan@example.com',
    EMPTY_CLIENT_DRAFT,
  );
  expect(next.contactName).toBe('Иван Петров');
  expect(next.email).toBe('ivan@example.com');
  expect(next.windowStart).toBe('11:00');
  expect(next.windowEnd).toBe('13:00');
  expect(next.problem).toBe('Интернет не работает');
});
