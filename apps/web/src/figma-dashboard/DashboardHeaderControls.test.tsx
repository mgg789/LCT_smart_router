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
