import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UserMenu } from './DashboardHeaderControls';

const noop = () => {};

describe('dashboard user menu layering', () => {
  it('keeps the avatar layer below passive toast cards', () => {
    const html = renderToStaticMarkup(
      <UserMenu
        open={false}
        covered={false}
        hasPreviousPlan={false}
        motionOn={false}
        demoStand={false}
        onToggle={noop}
        onSettings={noop}
        onOpenPreviousPlan={noop}
        onEndDay={noop}
        onRestartDay={noop}
        onReset={noop}
        onSignOut={noop}
      />,
    );

    expect(html).toContain('z-[60]');
    expect(html).not.toContain('z-[85]');
  });

  it('keeps the open menu actionable above passive toast cards', () => {
    const html = renderToStaticMarkup(
      <UserMenu
        open={true}
        covered={false}
        hasPreviousPlan={true}
        motionOn={false}
        demoStand={false}
        onToggle={noop}
        onSettings={noop}
        onOpenPreviousPlan={noop}
        onEndDay={noop}
        onRestartDay={noop}
        onReset={noop}
        onSignOut={noop}
      />,
    );

    expect(html).toContain('class="absolute z-[90]"');
    expect(html).toContain('Прошлый план');
  });
});

it('shows priorities only in manual mode immediately after settings', () => {
  const render = (manualMode: boolean) =>
    renderToStaticMarkup(
      <UserMenu
        open
        covered={false}
        manualMode={manualMode}
        hasPreviousPlan
        motionOn={false}
        demoStand={false}
        onToggle={noop}
        onSettings={noop}
        onOpenPreviousPlan={noop}
        onEndDay={noop}
        onRestartDay={noop}
        onReset={noop}
        onSignOut={noop}
      />,
    );
  const manual = render(true);
  expect(manual.indexOf('Настройки')).toBeLessThan(manual.indexOf('Приоритеты'));
  expect(manual.indexOf('Приоритеты')).toBeLessThan(manual.indexOf('Прошлый план'));
  expect(render(false)).not.toContain('Приоритеты');
});
