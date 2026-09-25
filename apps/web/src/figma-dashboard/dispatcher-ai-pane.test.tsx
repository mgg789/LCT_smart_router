import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DashboardAi, thoughtLabel } from './DispatcherAiPane';

it('names the thought duration in Russian', () => {
  expect(thoughtLabel(1)).toBe('Думал 1 секунду');
  expect(thoughtLabel(2)).toBe('Думал 2 секунды');
  expect(thoughtLabel(5)).toBe('Думал 5 секунд');
  expect(thoughtLabel(11)).toBe('Думал 11 секунд');
  expect(thoughtLabel(21)).toBe('Думал 21 секунду');
});

it('renders the dispatcher composer before a session is open', () => {
  const html = renderToStaticMarkup(<DashboardAi token={null} />);
  expect(html).toContain('Спроси меня о чем нибудь...');
  expect(html).toContain('Сообщение ассистенту');
  expect(html).toContain('Загружаем диалог');
});
