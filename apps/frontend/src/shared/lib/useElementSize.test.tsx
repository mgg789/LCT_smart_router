import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElementSize } from './useElementSize';

type Watcher = { element: Element; fire: (size: { width: number; height: number }) => void };

const watched: Watcher[] = [];

/**
 * jsdom has no ResizeObserver, so the hook would otherwise take its "no
 * observer" path and report nothing at all. This stub records what was observed
 * and lets a test say what that element then measured.
 */
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(element: Element) {
    watched.push({
      element,
      fire: (size) =>
        this.callback(
          [{ contentRect: size } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
    });
  }

  unobserve() {}
  disconnect() {}
}

function Probe({ ready }: { ready: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  return (
    <>
      <p>{`${Math.round(size.width)}×${Math.round(size.height)}`}</p>
      {ready ? <div data-testid="box" ref={ref} /> : null}
    </>
  );
}

function Screen() {
  // A screen that shows a placeholder first and mounts its real box later, as
  // every page here does while its queries are still running.
  const [ready, setReady] = useState(false);
  return (
    <>
      <button onClick={() => setReady(true)} type="button">
        загрузилось
      </button>
      <Probe ready={ready} />
    </>
  );
}

describe('useElementSize', () => {
  beforeEach(() => {
    watched.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures a box that was not there on the first render', async () => {
    render(<Screen />);
    expect(watched).toHaveLength(0);
    expect(screen.getByText('0×0')).toBeInTheDocument();

    // The element arrives on a later render; the hook has to notice it then.
    fireEvent.click(screen.getByRole('button', { name: 'загрузилось' }));
    await waitFor(() => expect(watched).toHaveLength(1));
    act(() => watched[0]?.fire({ width: 640, height: 268 }));
    expect(await screen.findByText('640×268')).toBeInTheDocument();
  });
});
