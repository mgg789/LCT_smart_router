import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientNewRequest } from './ClientNewRequest';
import { EMPTY_CLIENT_DRAFT } from './clientPreview';

it('renders oval reason chips, a pickable map and the AI gradient action', () => {
  const html = renderToStaticMarkup(
    <ClientNewRequest
      draft={EMPTY_CLIENT_DRAFT}
      notice={null}
      onChange={() => undefined}
      onSubmit={() => undefined}
      onAskAi={() => undefined}
    />,
  );
  expect(html).toContain('Новая заявка');
  expect(html).toContain('Интернет не работает');
  expect(html).toContain('calc(100 * var(--eu))');
  expect(html).toContain('Карта адреса заявки');
  expect(html).toContain('Открыть карту');
  expect(html).toContain('Заявка с AI');
  expect(html).toContain('client-ai-border');
  expect(html).not.toContain('Указать на карте');
  expect(html).not.toContain('Я согласен(а)');
});
