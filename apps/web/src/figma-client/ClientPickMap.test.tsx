import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientPickMap } from './ClientPickMap';

it('reserves a real-map container without a stub image or a pre-placed pin', () => {
  const html = renderToStaticMarkup(<ClientPickMap point={null} />);
  expect(html).toContain('Карта адреса заявки');
  expect(html).not.toContain('<img');
});
