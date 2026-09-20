import { useEffect, useRef, useState } from 'react';
import type { AlertView } from '../api/types';
import { alertTitle, isOpenAlert } from '../domain/alerts';

/** Brief arrival previews. Dismissal changes only the preview, never the server alert. */
export function AlertToasts({
  alerts,
  scope,
  onOpen,
}: {
  readonly alerts: readonly AlertView[];
  readonly scope: string;
  readonly onOpen: () => void;
}) {
  const shown = useRef<{ scope: string; ids: Set<string> }>({ scope, ids: new Set() });
  const [toasts, setToasts] = useState<Array<{ alert: AlertView; until: number }>>([]);
  useEffect(() => {
    if (shown.current.scope !== scope) {
      shown.current = { scope, ids: new Set() };
      setToasts([]);
    }
    const fresh = alerts.filter(
      (alert) =>
        !shown.current.ids.has(alert.id) &&
        (isOpenAlert(alert) || (alert.kind === 'notice' && alert.seenAt === null)),
    );
    for (const alert of alerts) shown.current.ids.add(alert.id);
    if (fresh.length)
      setToasts((current) =>
        [
          ...fresh.slice(0, 3).map((alert) => ({ alert, until: Date.now() + 8000 })),
          ...current,
        ].slice(0, 3),
      );
    setToasts((current) =>
      current.filter(({ alert }) =>
        alerts.some(
          (live) =>
            live.id === alert.id &&
            (isOpenAlert(live) || (live.kind === 'notice' && live.seenAt === null)),
        ),
      ),
    );
  }, [alerts, scope]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setToasts((current) => current.filter((item) => item.until > Date.now())),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <aside
      aria-live="polite"
      aria-label="Новые события"
      className="fixed bottom-5 right-5 z-50 w-80 max-w-[calc(100vw-2.5rem)] space-y-2"
    >
      {toasts.map(({ alert }) => (
        <div
          key={alert.id}
          className="rounded-2xl border border-line border-l-4 border-l-bee bg-white p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold">{alertTitle(alert.code)}</p>
            <button
              type="button"
              aria-label="Скрыть всплывающее сообщение"
              onClick={() =>
                setToasts((current) => current.filter((item) => item.alert.id !== alert.id))
              }
              className="text-muted"
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-xs text-muted">
            {alert.kind === 'notice'
              ? 'Уведомление сохранено во вкладке «Алерты».'
              : 'Требуется решение. Алерт остаётся во вкладке «Алерты».'}
          </p>
          <button
            type="button"
            onClick={() => {
              onOpen();
              setToasts([]);
            }}
            className="mt-3 text-sm font-medium underline"
          >
            Открыть алерты
          </button>
        </div>
      ))}
    </aside>
  );
}
