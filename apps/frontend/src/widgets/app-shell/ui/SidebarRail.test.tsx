import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../model/navItems';
import { SidebarRail } from './SidebarRail';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarRail />
    </MemoryRouter>,
  );
}

describe('SidebarRail', () => {
  it('lists every section of the mockup', () => {
    renderAt('/plan');

    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toBeInTheDocument();
    }
  });

  it('marks the section the dispatcher is on', () => {
    renderAt('/engineers');

    expect(screen.getByRole('link', { name: 'Инженеры' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'План дня' })).not.toHaveAttribute('aria-current');
  });
});
