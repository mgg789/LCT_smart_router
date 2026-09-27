import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  Hourglass,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { AiOperationState } from '../../api/ai';
import type { AiOperationView } from '../../hooks/useAssistantChat';
import { t } from '../../i18n';

interface Props {
  readonly operationId: string;
  /** May briefly be undefined if `operation_prepared` has not arrived yet (reconnect race). */
  readonly operation: AiOperationView | undefined;
  readonly disabled?: boolean;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}

interface StateMeta {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly badgeClassName: string;
  readonly spin?: boolean;
}

/**
 * Rendering for all seven `AiOperationState` values.
 *
 * `outcome_unknown` is the one entry that matters most here: it is what a write looks like
 * when the run died (a crash, a lost connection) after the call was made but before its
 * result was recorded. That is not the same fact as `cancelled_before_apply` — nothing was
 * undone, the change may well have happened — so it must never borrow the "отменено"
 * wording or a cancelled-style icon. It gets its own honest label, its own icon (a warning,
 * not a ban), and a dashed border that reads as "unresolved" rather than "closed". Do not
 * fold it into another state's styling, even to save a case in this table.
 */
const STATE_META: Record<AiOperationState, StateMeta> = {
  prepared: {
    label: t('components.ai.AiOperationCard.a83a4005e5'),
    icon: Hourglass,
    badgeClassName: 'border-line bg-canvas text-muted',
  },
  awaiting_confirmation: {
    label: t('components.ai.AiOperationCard.6bfcb02910'),
    icon: Clock3,
    badgeClassName: 'border-bee bg-bee text-ink',
  },
  running: {
    label: t('components.ai.AiOperationCard.176e44dd22'),
    icon: Loader2,
    badgeClassName: 'border-line bg-canvas text-ink',
    spin: true,
  },
  applied: {
    label: t('components.ai.AiOperationCard.a358e81fa2'),
    icon: CheckCircle2,
    badgeClassName: 'border-ink bg-ink text-white',
  },
  rejected: {
    label: t('components.ai.AiOperationCard.a997f50008'),
    icon: XCircle,
    badgeClassName: 'border-line bg-canvas text-muted',
  },
  cancelled_before_apply: {
    label: t('components.ai.AiOperationCard.59bca29fdb'),
    icon: Ban,
    badgeClassName: 'border-line bg-canvas text-muted',
  },
  outcome_unknown: {
    label: t('components.ai.AiOperationCard.8cf46ff28c'),
    icon: AlertTriangle,
    badgeClassName: 'border-dashed border-muted bg-canvas text-muted',
  },
};

const DECIDABLE_STATES: ReadonlySet<AiOperationState> = new Set([
  'prepared',
  'awaiting_confirmation',
]);

/** The confirmation card for one prepared operation: preview rows, actions, state badge. */
export function AiOperationCard({ operationId, operation, disabled, onApply, onCancel }: Props) {
  const state = operation?.state ?? 'prepared';
  const meta = STATE_META[state];
  const Icon = meta.icon;
  const decidable = DECIDABLE_STATES.has(state) && !disabled;
  return (
    <div className="mt-3 rounded-2xl border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">
          {operation?.action ?? t('components.ai.AiOperationCard.822d93cab5')}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta.badgeClassName}`}
        >
          <Icon className={`h-3.5 w-3.5 ${meta.spin ? 'animate-spin' : ''}`} />
          {meta.label}
        </span>
      </div>
      {operation && operation.preview.length > 0 && (
        <dl className="mt-3 space-y-1.5">
          {operation.preview.map((row) => (
            <div key={row.label} className="flex justify-between gap-4 text-sm">
              <dt className="text-muted">{row.label}</dt>
              <dd className="text-right font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {operation?.error && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {operation.error.message}
        </p>
      )}
      {decidable && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="mt-4 flex gap-2"
        >
          <button
            type="button"
            onClick={onApply}
            className="rounded-full bg-bee px-4 py-2 text-sm font-semibold text-ink"
          >
            {t('components.ai.AiOperationCard.e15f960d93')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-line bg-white px-4 py-2 text-sm"
          >
            {t('components.ai.AiOperationCard.7c47f7292b')}
          </button>
        </motion.div>
      )}
      <span className="sr-only">
        {t('components.ai.AiOperationCard.a949b54b13')}
        {operationId}
      </span>
    </div>
  );
}
