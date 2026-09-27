import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  answerWindowConfirmation,
  currentWindowConfirmation,
  subscribeWindowConfirmation,
} from '../api/windowConfirmation';

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
    new Intl.DateTimeFormat('ru-RU', {
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
            Вы уверены, что хотите сдвинуть временное окно заявки?
          </h2>
          <p className="mt-[16px] text-[18px]">
            Мы уведомим пользователя о смене времени, но высок риск, что он отменит свою заявку.
            Подтверждайте только если уверены.
          </p>
          <p className="mt-[16px] text-[16px] text-figma-muted">
            Заявка № {change.requestId.slice(0, 8)}
            <br />
            Было: {format(change.previousStartAt)} — {format(change.previousEndAt)}
            <br />
            Станет: {format(change.windowStartAt)} — {format(change.windowEndAt)}
          </p>
          <div className="mt-[24px] flex flex-wrap justify-end gap-[12px]">
            <button
              type="button"
              onClick={() => answerWindowConfirmation(false)}
              className="rounded-full bg-figma-soft px-[24px] py-[14px] font-semibold"
            >
              Отклонить шаг
            </button>
            <button
              type="button"
              onClick={() => answerWindowConfirmation(true)}
              className="rounded-full bg-figma-bee px-[24px] py-[14px] font-semibold"
            >
              Подтвердить сдвиг
            </button>
          </div>
        </>
      ) : null}
    </dialog>,
    document.body,
  );
}
