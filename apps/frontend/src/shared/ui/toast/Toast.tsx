import type { LucideIcon } from 'lucide-react';
import { Bot, MessageCircle, RefreshCw, Route, TriangleAlert, Wrench, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { Toast as ToastData, ToastKind } from '../../lib/toasts';

const ICON: Record<ToastKind, LucideIcon> = {
  system: Wrench,
  progress: RefreshCw,
  ai: Bot,
  chat: MessageCircle,
  done: Route,
  alert: TriangleAlert,
};

export interface ToastProps {
  toast: ToastData;
  onClose: () => void;
  onOpen?: () => void;
}

/**
 * One notice card (Figma 147:934), measured off the drawing: 425 wide, 20px
 * radius, the icon 24px from the left, title and text from 68px, the close
 * cross 21px from the top-right corner. Text runs to three lines, then an
 * ellipsis — a notice is a pointer to something, not the thing itself.
 *
 * Every kind is ink with white and grey text except the alert, which is the
 * accent yellow with ink, so a decision stands apart from information.
 */
export function Toast({ toast, onClose, onOpen }: ToastProps) {
  const Icon = ICON[toast.kind];
  const alert = toast.kind === 'alert';
  const progress = toast.progress;

  return (
    <div
      className={cn(
        'relative min-h-[132px] w-[425px] rounded-[20px] pt-5 pr-[52px] pb-6 pl-[68px] shadow-[0_18px_40px_rgba(39,41,48,0.18)]',
        alert ? 'bg-accent text-ink' : 'bg-ink text-white',
      )}
      role={alert ? 'alert' : 'status'}
    >
      <Icon
        aria-hidden
        className={cn('absolute top-[21px] left-6', alert ? 'text-ink' : 'text-white')}
        size={24}
        strokeWidth={1.8}
      />

      {onOpen ? (
        <button
          className="block text-left font-semibold text-[20px] leading-[26px] tracking-[-0.3px] after:absolute after:inset-0 after:rounded-[20px] after:content-['']"
          onClick={onOpen}
          type="button"
        >
          {toast.title}
        </button>
      ) : (
        <p className="truncate font-semibold text-[20px] leading-[26px] tracking-[-0.3px]">
          {toast.title}
        </p>
      )}

      {toast.kind === 'progress' ? (
        <div className="mt-[18px]">
          <div
            aria-label="Ход пересчёта"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress == null ? undefined : Math.round(progress * 100)}
            className="relative h-[10px] w-[265px] max-w-full overflow-hidden rounded-full bg-[#727478]"
            role="progressbar"
          >
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#00663c] to-[#0dcf7e]',
                progress == null
                  ? 'w-[35%] animate-[toast-indeterminate_1.4s_ease-in-out_infinite]'
                  : 'transition-[width] duration-300 ease-out',
              )}
              style={progress == null ? undefined : { width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          {toast.body ? (
            <p className="mt-[14px] font-semibold text-[#838383] text-[15px]">{toast.body}</p>
          ) : null}
        </div>
      ) : toast.body ? (
        <p
          className={cn(
            'mt-1 line-clamp-3 text-[18px] leading-6',
            alert ? 'text-ink' : 'text-[#838383]',
            // A finished recalculation's one line sits lower, as drawn.
            toast.kind === 'done' && 'mt-[18px]',
          )}
        >
          {toast.body}
        </p>
      ) : null}

      <button
        aria-label="Закрыть уведомление"
        className={cn(
          'absolute top-[17px] right-[17px] z-10 flex size-[26px] items-center justify-center transition-transform duration-150 hover:scale-110 active:scale-95',
          alert ? 'text-ink' : 'text-[#838383]',
        )}
        onClick={onClose}
        type="button"
      >
        <X aria-hidden size={20} strokeWidth={2.6} />
      </button>
    </div>
  );
}
