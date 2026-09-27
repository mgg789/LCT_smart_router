import { useId } from 'react';
import { t } from '../i18n';
import { ModalLayer, ModalScrim } from './modalLayer';

/** Asks before a policy change or window shift that adds lateness or unassigned work. */
export function WorsenModal({
  text,
  title = t('figma-dashboard.WorsenModal.84d10d1755'),
  cancelLabel = t('figma-dashboard.WorsenModal.8fbe9b75cb'),
  confirmLabel = t('figma-dashboard.WorsenModal.1ba4b5b92d'),
  onCancel,
  onConfirm,
}: {
  text: string | null;
  title?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <ModalLayer open={text !== null} motionOn={false} zClass="z-[110]">
      {text ? (
        <>
          <ModalScrim label={t('figma-dashboard.WorsenModal.e7c9a9e482')} onClose={onCancel} />
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
              {title}
            </h2>
            <p className="mt-[12px] font-medium text-[18px] text-figma-muted">{text}</p>
            <div className="mt-[24px] flex justify-end gap-[12px]">
              <button
                type="button"
                onClick={onCancel}
                className="h-[52px] rounded-[16px] bg-figma-soft px-[20px] font-semibold text-[16px] text-figma-ink"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="h-[52px] rounded-[16px] bg-figma-bee px-[20px] font-semibold text-[16px] text-figma-ink"
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </ModalLayer>
  );
}
