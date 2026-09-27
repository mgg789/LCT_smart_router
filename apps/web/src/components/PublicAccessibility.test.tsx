// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { confirmWindowChange } from '../api/windowConfirmation';
import { ClientEmailGate } from '../figma-client/ClientEmailGate';
import { DispatcherAuthPage } from '../figma-dashboard/DispatcherAuthPage';
import { EngineerLogin } from '../figma-engineer/EngineerLogin';
import { AppErrorBoundary } from './AppErrorBoundary';
import { WindowConfirmationDialog } from './WindowConfirmationDialog';

beforeEach(() => {
  document.documentElement.lang = 'ru';
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run all axe rules except contrast, which jsdom cannot measure without browser layout. */
async function expectAccessible(element: HTMLElement) {
  const result = await axe.run(element, { rules: { 'color-contrast': { enabled: false } } });
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
}

it('dispatcher login has named email, reachable submit and accessible password fallback', async () => {
  const user = userEvent.setup();
  const { container } = render(
    <DispatcherAuthPage
      submitting={false}
      onSession={() => undefined}
      onPassword={async () => undefined}
    />,
  );
  const email = screen.getByRole('textbox', { name: 'Почта' });
  await user.tab();
  expect(document.activeElement).toBe(email);
  await user.tab();
  expect(document.activeElement?.tagName).toBe('BUTTON');
  await expectAccessible(container);
  await user.click(screen.getByRole('button', { name: 'Войти паролем' }));
  expect(screen.getByLabelText('Пароль').getAttribute('type')).toBe('password');
  await expectAccessible(container);
});

it('engineer login has a named email field and keyboard-reachable action', async () => {
  const user = userEvent.setup();
  const { container } = render(<EngineerLogin motionOn={false} onSession={() => undefined} />);
  const email = screen.getByRole('textbox', { name: 'Email' });
  await user.tab();
  expect(document.activeElement).toBe(email);
  await user.tab();
  expect(document.activeElement?.tagName).toBe('BUTTON');
  await expectAccessible(container);
});

const clientProps = {
  purpose: 'list' as const,
  email: '',
  codeStep: false,
  busy: false,
  notice: null,
  onEmailChange: () => undefined,
  onRequestCode: () => undefined,
  onConfirm: () => undefined,
  onClose: () => undefined,
};
it('client login and every OTP cell have accessible names', async () => {
  const { container, rerender } = render(<ClientEmailGate {...clientProps} />);
  expect(screen.getByRole('textbox', { name: 'Email' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Назад' })).toBeTruthy();
  await expectAccessible(container);
  rerender(<ClientEmailGate {...clientProps} email="client@example.test" codeStep />);
  for (let index = 1; index <= 6; index += 1)
    expect(screen.getByRole('textbox', { name: `Цифра ${index} из 6` })).toBeTruthy();
  await expectAccessible(container);
});

it('render-error recovery is an accessible named alert with keyboard actions', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  function Broken(): never {
    throw new Error('intentional fixture');
  }
  const { container } = render(
    <AppErrorBoundary>
      <Broken />
    </AppErrorBoundary>,
  );
  expect(screen.getByRole('alert').getAttribute('aria-labelledby')).toBe('app-error-title');
  await expectAccessible(container);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Попробовать снова' }));
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Перезагрузить страницу' }),
  );
});

it('window confirmation dialog has a name and explicit accept/reject controls', async () => {
  // jsdom has no modal top layer; emulate only the native open/close primitives.
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  try {
    render(<WindowConfirmationDialog />);
    let decision: Promise<boolean> | undefined;
    await act(async () => {
      decision = confirmWindowChange({
        kind: 'window_change_confirmation',
        requestId: 'request-1',
        version: 1,
        previousStartAt: 1786946400,
        previousEndAt: 1786950000,
        windowStartAt: 1786950000,
        windowEndAt: 1786953600,
        confirmation: 'fixture-only',
      });
    });
    const dialog = screen.getByRole('dialog', { name: /Вы уверены/ });
    await expectAccessible(dialog);
    expect(screen.getByRole('button', { name: 'Подтвердить сдвиг' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить шаг' }));
    expect(await decision).toBe(false);
  } finally {
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
});
