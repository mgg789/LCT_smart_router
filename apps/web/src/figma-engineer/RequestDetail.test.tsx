import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DESIGN_PREVIEW_DAY, DESIGN_PREVIEW_PLAN } from './designPreview';
import { engineerListItems } from './engineerDay';
import { EngineerListCard } from './RequestCards';
import { RequestDetail } from './RequestDetail';

it('keeps detail actions at the screen bottom and navigation pill-shaped', () => {
  const item = engineerListItems(DESIGN_PREVIEW_PLAN, DESIGN_PREVIEW_DAY).find(
    (entry) => entry.kind === 'job',
  );
  if (item?.kind !== 'job') throw new Error('Missing fixture job');
  const html = renderToStaticMarkup(
    <RequestDetail
      item={item}
      nowMs={0}
      onBack={() => {}}
      onRoute={() => {}}
      actions={<button type="button">Завершить</button>}
    />,
  );
  expect(html).toContain('min-h-dvh');
  expect(html).toContain('rounded-full bg-figma-ink');
  expect(html).toMatch(/class="mt-auto"[^>]*><button type="button">Завершить/);
  expect(html).toContain('Местоположение заявки');
});

it('lowers the lunch caption by exactly two CSS pixels', () => {
  const html = renderToStaticMarkup(
    <EngineerListCard
      item={{ kind: 'lunch', startAt: 0, endAt: 1800 }}
      motionOn={false}
      delay={0}
    />,
  );
  expect(html).toMatch(/position:relative;top:2px[^>]*>Обед/);
});
