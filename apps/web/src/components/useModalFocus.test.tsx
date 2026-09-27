// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalLayer, ModalScrim } from '../figma-dashboard/modalLayer';
import { useModalFocus } from './useModalFocus';

function Dialog({ open = true, close = () => {} }: { open?: boolean; close?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useModalFocus(root, open, close);
  return open ? (
    <div ref={root} role="dialog" aria-label="Test">
      <button type="button">First</button>
      <button type="button" disabled>
        Disabled
      </button>
      <button type="button">Last</button>
    </div>
  ) : null;
}

afterEach(cleanup);

describe('custom modal focus', () => {
  it('focuses content, wraps both directions, rejects escaped focus and restores the opener', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const view = render(<Dialog />);
    const first = view.getByText('First');
    const last = view.getByText('Last');
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
    trigger.focus();
    expect(document.activeElement).toBe(first);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('only closes the top dialog, then restores focus inside the underlying dialog', () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    const lower = render(<Dialog close={lowerClose} />);
    const first = lower.getByText('First');
    const upper = render(<Dialog close={upperClose} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(upperClose).toHaveBeenCalledOnce();
    expect(lowerClose).not.toHaveBeenCalled();
    upper.unmount();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(lowerClose).toHaveBeenCalledOnce();
  });

  it('uses the scrim close action without bypassing a disabled busy dialog', () => {
    const close = vi.fn();
    const view = render(
      <ModalLayer open motionOn={false}>
        <ModalScrim label="Close" disabled onClose={close} />
        <section role="dialog" aria-label="Busy">
          <button type="button">Content</button>
        </section>
      </ModalLayer>,
    );
    expect(document.activeElement).toBe(view.getByText('Content'));
    expect(view.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    view.rerender(
      <ModalLayer open motionOn={false}>
        <ModalScrim label="Close" onClose={close} />
        <section role="dialog" aria-label="Busy">
          <button type="button">Content</button>
        </section>
      </ModalLayer>,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('lets a native modal own focus and Escape above a custom dialog', () => {
    const close = vi.fn();
    render(<Dialog close={close} />);
    const native = document.createElement('dialog');
    const button = document.createElement('button');
    native.append(button);
    document.body.append(native);
    // jsdom has no showModal implementation; emulate only the browser's :modal lookup.
    const query = document.querySelector.bind(document);
    const modalLookup = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector) => (selector === 'dialog:modal' ? native : query(selector)));
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    modalLookup.mockRestore();
    native.remove();
  });

  it('keeps an empty dialog focusable and traps Tab without controls', () => {
    const view = render(
      <ModalLayer open motionOn={false}>
        <section role="dialog" aria-label="Loading">
          Loading
        </section>
      </ModalLayer>,
    );
    const dialog = view.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog);
  });

  it('inerts siblings at every ancestor level and preserves existing inert attributes', () => {
    const background = document.createElement('main');
    const existing = document.createElement('aside');
    existing.setAttribute('inert', 'inert');
    const host = document.createElement('div');
    document.body.append(background, existing, host);
    const view = render(
      <div>
        <p data-testid="local">Background text</p>
        <Dialog />
      </div>,
      { container: host },
    );
    expect(background.hasAttribute('inert')).toBe(true);
    expect(view.getByTestId('local').hasAttribute('inert')).toBe(true);
    expect(view.getByRole('dialog').closest('[inert]')).toBeNull();
    view.unmount();
    expect(background.hasAttribute('inert')).toBe(false);
    expect(existing.getAttribute('inert')).toBe('inert');
    background.remove();
    existing.remove();
    host.remove();
  });

  it('keeps a sibling modal interactive and retains shared claims when lower layers unmount first', () => {
    const background = document.createElement('main');
    document.body.append(background);
    const lower = render(<Dialog />);
    const upper = render(<Dialog />);
    expect(lower.container.hasAttribute('inert')).toBe(true);
    expect(upper.container.querySelector('[role="dialog"]')?.closest('[inert]')).toBeNull();
    lower.unmount();
    expect(background.hasAttribute('inert')).toBe(true);
    expect(upper.container.querySelector('[role="dialog"]')?.closest('[inert]')).toBeNull();
    upper.unmount();
    expect(background.hasAttribute('inert')).toBe(false);
    background.remove();
  });

  it('inerts background siblings mounted after the dialog opens', async () => {
    const view = render(<Dialog />);
    const late = document.createElement('aside');
    document.body.append(late);
    await waitFor(() => expect(late.hasAttribute('inert')).toBe(true));
    view.unmount();
    expect(late.hasAttribute('inert')).toBe(false);
    late.remove();
  });

  it('does not trap a docked or closed surface', () => {
    const close = vi.fn();
    render(<Dialog open={false} close={close} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
