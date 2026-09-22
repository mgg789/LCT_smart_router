import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientRequests } from './ClientRequests';
import { CLIENT_PREVIEW_REQUESTS } from './clientPreview';

it('shows the live card, new-request action and archive rows from Figma MAIN', () => {
  const html = renderToStaticMarkup(
    <ClientRequests
      requests={CLIENT_PREVIEW_REQUESTS}
      notice={null}
      motionOn={false}
      onOpen={() => undefined}
      onNewRequest={() => undefined}
    />,
  );
  expect(html).toContain('Список заявок');
  expect(html).toContain('ул. Таганская, 24');
  expect(html).not.toContain('Открыть карточку');
  expect(html).toContain('Алексей Соколов');
  expect(html).toContain('в пути');
  expect(html).toContain('Архив');
  expect(html).toContain('Офис - ул. Лесная, 7');
  expect(html).toContain('Новая заявка');
  expect(html).toContain('Местоположение заявки');
  expect(html).toContain('opacity:0.7');
  expect(html).toContain('opacity:1');
});
