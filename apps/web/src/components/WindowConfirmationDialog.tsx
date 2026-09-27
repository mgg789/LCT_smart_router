import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  answerWindowConfirmation,
  currentWindowConfirmation,
  subscribeWindowConfirmation,
} from '../api/windowConfirmation';
import { locale, t } from '../i18n';

/** Native modal gates every window write, including background AI and sequential alert actions. */
export function WindowConfirmationDialog() {
  const change = useSyncExternalStore(
    subscribeWindowConfirmation,
    currentWindowConfirmation,
    () => null,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (change && !dialog.current?.open) dialog.current?.showModal();
    if (!change && dialog.current?.open) dialog.current.close();
  }, [change]);
  const format = (value: number) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value * 1000));
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="window-confirmation-title"
      onCancel={(event) => {
        event.preventDefault();
        answerWindowConfirmation(false);
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-[28px] border-0 bg-white p-[28px] text-figma-ink shadow-xl backdrop:bg-figma-ink/40"
    >
      {change ? (
        <>
          <h2 id="window-confirmation-title" className="font-extrabold text-[24px]">
            {t('components.WindowConfirmationDialog.f0c3ae8341')}
          </h2>
          <p className="mt-[16px] text-[18px]">
            {t('components.WindowConfirmationDialog.b886fbe326')}
          </p>
          <p className="mt-[16px] text-[16px] text-figma-muted">
            {t('components.WindowConfirmationDialog.aa0ad3a10e')}
            {change.requestId.slice(0, 8)}
            <br />
            {t('components.WindowConfirmationDialog.7831171752')}
            {format(change.previousStartAt)} — {format(change.previousEndAt)}
            <br />
            {t('components.WindowConfirmationDialog.a5ebdb6349')}
            {format(change.windowStartAt)} — {format(change.windowEndAt)}
          </p>
          <div className="mt-[24px] flex flex-wrap justify-end gap-[12px]">
            <button
              type="button"
              onClick={() => answerWindowConfirmation(false)}
              className="rounded-full bg-figma-soft px-[24px] py-[14px] font-semibold"
            >
              {t('components.WindowConfirmationDialog.d518543d2d')}
            </button>
            <button
              type="button"
              onClick={() => answerWindowConfirmation(true)}
              className="rounded-full bg-figma-bee px-[24px] py-[14px] font-semibold"
            >
              {t('components.WindowConfirmationDialog.e5db618a36')}
            </button>
          </div>
        </>
      ) : null}
    </dialog>,
    document.body,
  );
}
