import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RequestMap } from './RequestMap';

it('reserves an accessible real-map container without a mock image', () => {
  const html = renderToStaticMarkup(<RequestMap lat={55.72} lon={37.75} />);
  expect(html).toContain('Местоположение заявки');
  expect(html).not.toContain('<img');
});
