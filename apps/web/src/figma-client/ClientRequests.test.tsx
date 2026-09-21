import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CLIENT_PREVIEW_REQUESTS } from './clientPreview';
import { ClientRequests } from './ClientRequests';

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
  expect(html).toContain('Открыть карточку');
  expect(html).toContain('Алексей Соколов');
  expect(html).toContain('в пути');
  expect(html).toContain('Архив');
  expect(html).toContain('Офис - ул. Лесная, 7');
  expect(html).toContain('Новая заявка');
  expect(html).toContain('Местоположение заявки');
  expect(html).toContain('rgba(255, 255, 255, 0.7)');
});
