import type { LucideIcon } from 'lucide-react';
import { ArrowRight, Bell, ClipboardClock, MessageCircle, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import type { AlertSeverity, AlertView } from '@/entities/alert';
import { alertTitle, unseenAlerts, useAlerts } from '@/entities/alert';
import { cn } from '@/shared/lib';
import { Popover } from '@/shared/ui';

export interface AlertsPopoverProps {
  onClose: () => void;
}

/** How many the drawing fits; the rest live on the Alerts section. */
const PREVIEW_COUNT = 3;

/**
 * Icons stand in for the per-code set of the drawing. The contract enumerates no
 * catalogue of alert codes, so severity is the only honest thing to key on.
 */
const ICON_BY_SEVERITY: Record<AlertSeverity, LucideIcon> = {
  error: TriangleAlert,
  warning: ClipboardClock,
  info: MessageCircle,
};

function AlertCard({ alert }: { alert: AlertView }) {
  const Icon = ICON_BY_SEVERITY[alert.severity];
  const emphasised = alert.severity === 'error';

  return (
    <li
      className={cn(
        // 99px is the drawn height; a longer reason grows the card rather than being clipped.
        'flex min-h-[99px] items-center gap-[11px] rounded-[20px] px-9 py-5',
        emphasised ? 'bg-accent' : 'border-2 border-ink bg-surface',
      )}
    >
      <Icon aria-hidden className="shrink-0 text-ink" size={30} />
      <span className="text-[20px] font-semibold tracking-[-0.6px] text-ink">
        {alertTitle(alert)}
      </span>
    </li>
  );
}

/**
 * Alerts popover of the header (Figma `140:850`): the three freshest alerts still
 * waiting for the dispatcher, then a way into the full section.
 */
export function AlertsPopover({ onClose }: AlertsPopoverProps) {
  const alerts = useAlerts();
  const pending = alerts.data ? unseenAlerts(alerts.data.alerts).slice(0, PREVIEW_COUNT) : [];

  return (
    <Popover
      className="-top-1 -right-1"
      closeIcon={<Bell aria-hidden size={20} />}
      onClose={onClose}
      title="Алерты и уведомления"
    >
      {alerts.isPending ? <p className="text-[14px] text-ink/60">Загружаем алерты…</p> : null}
      {alerts.isError ? (
        <p className="text-[14px] text-danger">Не удалось прочитать алерты.</p>
      ) : null}
      {alerts.data && pending.length === 0 ? (
        <p className="text-[14px] text-ink/60">Новых алертов нет.</p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="flex flex-col gap-[19px]">
          {pending.map((alert) => (
            <AlertCard alert={alert} key={alert.id} />
          ))}
        </ul>
      ) : null}

      <Link
        className="mt-[16px] flex items-center justify-center gap-[2px] text-[20px] font-semibold tracking-[-0.6px] text-ink"
        onClick={onClose}
        to={ROUTES.alerts}
      >
        К Алёртам
        <ArrowRight aria-hidden size={24} />
      </Link>
    </Popover>
  );
}
