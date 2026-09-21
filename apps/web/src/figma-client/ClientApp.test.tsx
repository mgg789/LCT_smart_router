import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientApp } from './ClientApp';

it('opens the client phone column on the new-request home', () => {
  const html = renderToStaticMarkup(<ClientApp />);
  expect(html).toContain('client-phone');
  expect(html).toContain('Новая заявка');
  expect(html).toContain('NAVIX');
  expect(html).toContain('aria-label="Меню"');
});
