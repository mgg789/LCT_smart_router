import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReplanDeltaCard } from './ReplanDeltaCard';

it('shows the calculated plan delta and rollback action', () => {
  const html = renderToStaticMarkup(
    <ReplanDeltaCard
      delta={{
        transferred: 2,
        shifted: 3,
        slaBefore: 2,
        slaAfter: 1,
        solveMs: 840,
        lines: [
          {
            requestId: '1e5bfd79-72f3-49a9-8f0f-234063a23da6',
            engineerName: null,
            text: 'Не назначена',
          },
          { requestId: null, engineerName: 'Ирина Соколова', text: 'Обед сдвинут' },
        ],
      }}
      canReject
      busy={false}
      motionOn={false}
      onAccept={() => undefined}
      onReject={() => undefined}
      onOpenRequest={() => undefined}
    />,
  );
  expect(html).toContain('Что изменилось');
  expect(html).toContain('2 → 1');
  expect(html).toContain('1e5bfd79');
  expect(html).not.toContain('1e5bfd79-72f3');
  expect(html).toContain('Не назначена');
  expect(html).toContain('Ирина Соколова');
  expect(html).toContain('Обед сдвинут');
  expect(html).toContain('Вернуть прежний план');
});
