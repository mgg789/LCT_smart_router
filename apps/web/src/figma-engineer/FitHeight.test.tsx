import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FitHeight } from './FitHeight';

/**
 * The wrapper has to stand in the tree whether or not it is fitting anything.
 * Rendering it conditionally changed the element type at that position, so
 * React unmounted the screen inside it — the new request lost the mode the fit
 * had just been turned on for.
 */
it('keeps the same pair of wrappers whether or not it is fitting', () => {
  const on = renderToStaticMarkup(
    <FitHeight active={true}>
      <p>screen</p>
    </FitHeight>,
  );
  const off = renderToStaticMarkup(
    <FitHeight active={false}>
      <p>screen</p>
    </FitHeight>,
  );

  expect(on).toContain('phone-desk-fit');
  expect(off).not.toContain('phone-desk-fit');
  for (const html of [on, off]) {
    expect(html.match(/<div/g)).toHaveLength(2);
    expect(html).toContain('<p>screen</p>');
  }
});

it('hands the pane height through to the screen when it is switched off', () => {
  const off = renderToStaticMarkup(
    <FitHeight active={false}>
      <p>screen</p>
    </FitHeight>,
  );
  // Both wrappers, or a screen asking for `h-full` resolves against `auto`.
  expect(off.match(/class="h-full"/g)).toHaveLength(2);
});
