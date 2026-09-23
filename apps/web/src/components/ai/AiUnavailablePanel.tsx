import { CloudOff, LogIn, OctagonPause, Timer } from 'lucide-react';
import type { ComponentType } from 'react';
import type { AiUnavailableReason } from '../../hooks/useAssistantChat';
import { formatClock } from '../../lib/time';

interface Props {
  readonly reason: AiUnavailableReason;
  /** Only meaningful for `quota`: when the daily budget resets. */
  readonly quotaResetAt?: number | null;
}

interface ReasonMeta {
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly detail: string;
}

/**
 * The four system states a chat can be in instead of a live dialogue.
 *
 * Quota is deliberately its own state, never folded into `provider`: running out of
 * budget is an expected, everyday condition, not evidence that the assistant is broken
 * (context/35 section 8). Mixing the two would make a dispatcher distrust a healthy
 * provider every time the account simply used up its daily allowance.
 */
function reasonMeta(
  reason: AiUnavailableReason,
  quotaResetAt: number | null | undefined,
): ReasonMeta {
  switch (reason) {
    case 'provider':
      return {
        icon: CloudOff,
        title: 'AI сейчас недоступен',
        detail: 'Не удалось связаться с провайдером модели. Попробуйте ещё раз через минуту.',
      };
    case 'quota':
      return {
        icon: Timer,
        title: 'Дневная квота исчерпана',
        detail:
          quotaResetAt != null
            ? `Лимит обращений на сегодня закончился. Обновится в ${formatClock(quotaResetAt)}.`
            : 'Лимит обращений на сегодня закончился. Обновится в начале следующих суток.',
      };
    case 'auth':
      return {
        icon: LogIn,
        title: 'Требуется вход',
        detail: 'Сессия закончилась или недействительна. Войдите снова, чтобы продолжить диалог.',
      };
    case 'stopped':
      return {
        icon: OctagonPause,
        title: 'Запуск остановлен',
        detail:
          'Обработка была остановлена системой. Отправьте сообщение ещё раз, чтобы начать заново.',
      };
  }
}

/** Replaces the composer with one of the four system-unavailable states. */
export function AiUnavailablePanel({ reason, quotaResetAt }: Props) {
  const meta = reasonMeta(reason, quotaResetAt);
  const Icon = meta.icon;
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-canvas p-6 text-center"
    >
      <Icon className="h-6 w-6 text-muted" />
      <p className="text-sm font-semibold">{meta.title}</p>
      <p className="max-w-sm text-xs text-muted">{meta.detail}</p>
    </div>
  );
}
