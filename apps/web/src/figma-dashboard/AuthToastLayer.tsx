import { dismissToast, useToasts } from './toasts';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

function closeAuthToast(id: string, event?: { preventDefault(): void; stopPropagation(): void }) {
  event?.preventDefault();
  event?.stopPropagation();
  dismissToast(id);
}

/**
 * Viewport-fixed stack for login errors. Same alert card as MAIN, painted danger-red.
 * The wrapper is only as large as the cards so it cannot swallow clicks on the form.
 */
export function AuthToastLayer() {
  const toasts = useToasts().filter((item) => item.kind === 'error');
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-[28px] top-[28px] z-[120] flex flex-col gap-[16px]">
      {toasts.map((toast) => (
        <article
          key={toast.id}
          data-toast-card
          aria-label={`${toast.title}. ${toast.body}`}
          className="pointer-events-auto relative h-[132px] w-[425px] overflow-hidden rounded-[20px] bg-figma-danger"
        >
          <div className="absolute left-[15px] top-[8px] flex h-[42px] w-[43px] items-center justify-center rounded-[10px]">
            <FigmaIcon src={FIGMA_ASSETS.toastAlert} alt="" width={25} height={25} className="brightness-0 invert" />
          </div>
          <p className="figma-nowrap absolute left-[68px] top-[19px] max-w-[280px] overflow-hidden font-semibold text-[20px] leading-none text-ellipsis text-white">
            {toast.title}
          </p>
          <button
            type="button"
            data-toast-close
            aria-label="Закрыть уведомление"
            className="absolute right-[8px] top-[8px] z-20 flex size-[40px] items-center justify-center transition-transform duration-150 hover:scale-110"
            onPointerDown={(event) => closeAuthToast(toast.id, event)}
            onClick={(event) => closeAuthToast(toast.id, event)}
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastClose} alt="" width={20} height={20} className="brightness-0 invert" />
            </span>
          </button>
          <p className="absolute left-[68px] top-[48px] w-[327px] font-medium text-[18px] leading-[22px] tracking-[-0.3px] text-white">
            {toast.body}
          </p>
        </article>
      ))}
    </div>
  );
}
