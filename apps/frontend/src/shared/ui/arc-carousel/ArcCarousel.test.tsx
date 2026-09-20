import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ArcCarousel } from './ArcCarousel';

const CREWS = ['Соколов', 'Попов', 'Иванов', 'Петров'];

function Deck({ start = 0 }: { start?: number }) {
  const [active, setActive] = useState(start);
  return (
    <>
      <p data-testid="front">{CREWS[active]}</p>
      <ArcCarousel
        activeIndex={active}
        aria-label="Бригады"
        items={CREWS}
        keyOf={(crew) => crew}
        labelOf={(crew) => crew}
        onActiveIndexChange={setActive}
        renderCard={(crew) => <span>{crew}</span>}
      />
    </>
  );
}

describe('ArcCarousel', () => {
  it('brings a card to the front when it is clicked', async () => {
    const user = userEvent.setup();
    render(<Deck />);

    await user.click(screen.getByTitle('Иванов'));

    expect(screen.getByTestId('front')).toHaveTextContent('Иванов');
  });

  it('walks the deck with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Deck />);

    screen.getByRole('region', { name: 'Бригады' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByTestId('front')).toHaveTextContent('Попов');

    await user.keyboard('{ArrowLeft}');

    expect(screen.getByTestId('front')).toHaveTextContent('Соколов');
  });

  it('wraps past the last card instead of stopping', async () => {
    const user = userEvent.setup();
    render(<Deck start={CREWS.length - 1} />);

    screen.getByRole('region', { name: 'Бригады' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByTestId('front')).toHaveTextContent('Соколов');
  });

  it('wraps before the first card instead of stopping', async () => {
    const user = userEvent.setup();
    render(<Deck />);

    screen.getByRole('region', { name: 'Бригады' }).focus();
    await user.keyboard('{ArrowLeft}');

    expect(screen.getByTestId('front')).toHaveTextContent('Петров');
  });

  it('marks the front card as the current one', async () => {
    const user = userEvent.setup();
    render(<Deck />);

    expect(screen.getByTitle('Соколов')).toHaveAttribute('aria-current', 'true');

    await user.click(screen.getByTitle('Попов'));

    expect(screen.getByTitle('Попов')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTitle('Соколов')).toHaveAttribute('aria-current', 'false');
  });
});
