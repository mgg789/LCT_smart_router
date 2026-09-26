import { useId } from 'react';
import { ModalLayer, ModalScrim } from './modalLayer';

/** Asks before a policy change or window shift that adds lateness or unassigned work. */
export function WorsenModal({
  text,
  onCancel,
  onConfirm,
}: {
  text: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <ModalLayer open={text !== null} motionOn={false} zClass="z-[110]">
      {text ? (
        <>
          <ModalScrim label="Закрыть предупреждение" onClose={onCancel} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative flex w-[560px] flex-col rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
          >
            <h2
              id={titleId}
              className="font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
            >
              Станет хуже
            </h2>
            <p className="mt-[12px] font-medium text-[18px] text-figma-muted">{text}</p>
            <div className="mt-[24px] flex justify-end gap-[12px]">
              <button
                type="button"
                onClick={onCancel}
                className="h-[52px] rounded-[16px] bg-figma-soft px-[20px] font-semibold text-[16px] text-figma-ink"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="h-[52px] rounded-[16px] bg-figma-bee px-[20px] font-semibold text-[16px] text-figma-ink"
              >
                Всё равно применить
              </button>
            </div>
          </div>
        </>
      ) : null}
    </ModalLayer>
  );
}
