import { CloudOff, LogIn, OctagonPause, Timer } from 'lucide-react';
import type { ComponentType } from 'react';
import type { AiUnavailableReason } from '../../hooks/useAssistantChat';
import { t } from '../../i18n';
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
        title: t('components.ai.AiUnavailablePanel.17096a674b'),
        detail: t('components.ai.AiUnavailablePanel.4e8cd4bd52'),
      };
    case 'quota':
      return {
        icon: Timer,
        title: t('components.ai.AiUnavailablePanel.1778210ec0'),
        detail:
          quotaResetAt != null
            ? t('components.ai.AiUnavailablePanel.855fa3432f', {
                value0: formatClock(quotaResetAt),
              })
            : t('components.ai.AiUnavailablePanel.c95630c26c'),
      };
    case 'auth':
      return {
        icon: LogIn,
        title: t('components.ai.AiUnavailablePanel.9019d4a6dc'),
        detail: t('components.ai.AiUnavailablePanel.3559ca8159'),
      };
    case 'stopped':
      return {
        icon: OctagonPause,
        title: t('components.ai.AiUnavailablePanel.8e3b73494c'),
        detail: t('components.ai.AiUnavailablePanel.bc8b62aa0a'),
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
