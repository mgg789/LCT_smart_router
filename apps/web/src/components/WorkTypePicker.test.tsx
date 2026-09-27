import type { WorkTypeView } from '@lct/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkTypeLabel } from './WorkTypeLabel';
import { WorkTypePicker } from './WorkTypePicker';

const rows: WorkTypeView[] = [
  {
    code: 'outage',
    title: 'Авария',
    category: 'emergency',
    categoryTitle: 'Авария',
    serviceDurationSec: 6000,
    requiredSkill: 'emergency',
  },
  {
    code: 'no_link',
    title: 'Нет линка',
    category: 'service',
    categoryTitle: 'Ремонт / Дозаказ',
    serviceDurationSec: 4800,
    requiredSkill: 'emergency',
  },
];

it('marks the network emergency red without confusing an emergency skill with its business group', () => {
  const render = (value: string) =>
    renderToStaticMarkup(
      <WorkTypePicker
        rows={rows}
        value={value}
        onChange={() => {}}
        error={null}
        onRetry={() => {}}
      />,
    );
  expect(render('outage')).toContain('aria-pressed="true"');
  expect(render('outage')).toContain('Направим первую свободную бригаду');
  expect(render('no_link')).toContain('aria-pressed="false"');
  expect(render('no_link')).not.toContain('Направим первую свободную бригаду');
  expect(render('no_link')).toContain('Ремонт / Дозаказ');
  expect(
    renderToStaticMarkup(<WorkTypeLabel category="emergency">Авария</WorkTypeLabel>),
  ).toContain('bg-figma-danger');
  expect(
    renderToStaticMarkup(<WorkTypeLabel category="service">Нет линка</WorkTypeLabel>),
  ).not.toContain('bg-figma-danger');
});

it('keeps writes unavailable when the catalogue could not be loaded', () => {
  const html = renderToStaticMarkup(
    <WorkTypePicker
      rows={[]}
      value=""
      onChange={() => {}}
      error="Каталог недоступен"
      onRetry={() => {}}
    />,
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain('role="alert"');
  expect(html).toContain('Повторить');
});
