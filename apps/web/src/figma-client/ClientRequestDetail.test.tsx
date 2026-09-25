import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientRequestDetail } from './ClientRequestDetail';
import { CLIENT_DETAIL_NOW_MS, CLIENT_PREVIEW_REQUESTS } from './clientPreview';

it('keeps the Figma request ticket and planned-start block', () => {
  const item = CLIENT_PREVIEW_REQUESTS[0];
  if (!item) throw new Error('Missing preview request');
  const html = renderToStaticMarkup(
    <ClientRequestDetail
      item={item}
      nowMs={CLIENT_DETAIL_NOW_MS}
      notice={null}
      onBack={() => undefined}
      onChangeTime={() => undefined}
    />,
  );
  expect(html).toContain('Через 25 минут');
  expect(html).toContain('Заявка № 1042');
  expect(html).toContain('Адрес на карте');
  expect(html).toContain('плановое начало визита');
  expect(html).toContain('Изменить время');
  expect(html).toContain('data-seo-path="/client/requests/req-1042"');
  expect(html).toContain('data-seo-title=');
  expect(html).toContain('rounded-full bg-figma-ink');
});
