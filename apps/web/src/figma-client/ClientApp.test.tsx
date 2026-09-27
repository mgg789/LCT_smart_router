import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CLIENT_ASSETS } from './assets';
import { ClientApp } from './ClientApp';

it('opens the client phone column on the new-request home', () => {
  const html = renderToStaticMarkup(<ClientApp />);
  expect(html).toContain('client-phone');
  expect(html).toContain('aria-label="Тип заявки"');
  expect(html).toContain('ФИО');
  expect(html).not.toContain('Отправить рассказ');
  expect(html).toContain('NAVIX');
  expect(html).toContain('aria-label="Меню"');
  expect(html).not.toContain(CLIENT_ASSETS.logo);
});
