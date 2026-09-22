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
        notes: ['Средний сдвиг — 11 минут'],
      }}
      canReject
      busy={false}
      motionOn={false}
      onAccept={() => undefined}
      onReject={() => undefined}
    />,
  );
  expect(html).toContain('Что изменилось');
  expect(html).toContain('2 → 1');
  expect(html).toContain('Средний сдвиг — 11 минут');
  expect(html).toContain('Вернуть прежний план');
});
