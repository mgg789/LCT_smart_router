import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientNewRequest } from './ClientNewRequest';
import { EMPTY_CLIENT_DRAFT } from './clientPreview';

it('renders the Figma new-request form with send disabled until consent', () => {
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
  expect(html).toContain('Указать на карте');
  expect(html).toContain('Заявка с AI');
  expect(html).toContain('disabled');
  expect(html).toContain('Я согласен(а) на обработку данных');
});
