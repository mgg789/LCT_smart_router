import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientSent } from './ClientSent';
import { CLIENT_PREVIEW_REQUESTS } from './clientPreview';

it('centers the complete sent-request content group in the remaining phone height', () => {
  const item = CLIENT_PREVIEW_REQUESTS[0];
  expect(item).toBeDefined();
  if (!item) return;
  const html = renderToStaticMarkup(
    <ClientSent item={item} onList={() => undefined} onAnother={() => undefined} />,
  );
  expect(html).toContain('flex-1');
  expect(html).toContain('justify-center');
  expect(html).toContain('Заявка отправлена');
  expect(html).toContain('Мои заявки');
  expect(html).toContain('Ещё заявка');
});
