import { useEffect, useRef } from 'react';
import type { AssistedProposal } from '@/entities/dispatcher-constraints';
import type { EngineerView } from '@/entities/engineer';
import type { RequestView } from '@/entities/request';
import { formatTime } from '@/shared/lib';
import { Button } from '@/shared/ui';

const RISK_LABELS: Record<string, string> = {
  ASSIGNMENTS_LOST: 'Часть назначенных заявок останется без исполнителя',
  MASS_REASSIGNMENT: 'Изменятся исполнители нескольких заявок',
  MASS_REORDER: 'Существенно изменится порядок маршрутов',
  SIGNIFICANT_DELAY: 'Начало некоторых работ сдвинется на 30 минут или больше',
  NEW_WINDOW_VIOLATION: 'Появится завершение за пределами клиентского окна',
  ADDITIONAL_ENGINEERS: 'Понадобятся дополнительные резервные инженеры',
};

export interface CorrectionReviewProps {
  proposal: AssistedProposal;
  requests: RequestView[];
  engineers: EngineerView[];
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRecalculate: () => void;
}

/** Native modal keeps keyboard focus inside a consequential decision until it is resolved. */
export function CorrectionReview({
  proposal,
  requests,
  engineers,
  busy,
  error,
  onConfirm,
  onCancel,
  onRecalculate,
}: CorrectionReviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    element?.querySelector('button')?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  const requestName = (id: string) =>
    requests.find((row) => row.id === id)?.addressText || `Заявка ${id.slice(0, 8)}`;
  const engineerName = (id: string) =>
    engineers.find((row) => row.id === id)?.displayName ||
    (id.startsWith('covering-') ? 'Резервная бригада' : 'Инженер');
  const { impact } = proposal;
  const blocked = proposal.blockers.length > 0 || proposal.state === 'blocked';
  return (
    <dialog
      aria-busy={busy}
      aria-labelledby="correction-title"
      className="m-auto max-h-[85vh] w-[min(760px,calc(100vw-32px))] overflow-y-auto rounded-[24px] border-0 bg-surface p-6 text-ink shadow-xl backdrop:bg-ink/40"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      ref={dialog}
    >
      <h2 className="font-display text-[26px]" id="correction-title">
        {blocked
          ? 'Изменение не удалось разместить'
          : proposal.requiresConfirmation
            ? 'Проверьте последствия'
            : 'Предложение плана'}
      </h2>
      <p className="mt-2 text-[15px] text-ink/65">
        {proposal.source === 'automatic'
          ? 'Автоматика пересчитала день с учётом закреплений.'
          : 'Изменение проверено вместе с остальными заявками дня.'}{' '}
        До применения действует текущий план.
      </p>
      {blocked ? (
        <div
          className="mt-4 rounded-2xl border border-danger/30 p-4 text-[15px] text-danger"
          role="alert"
        >
          Расчёт не нашёл допустимый план с этими закреплениями. Измените исполнителя, порядок или
          снимите закрепление.
          {proposal.blockers.flatMap((row) => row.requestIds).length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {[...new Set(proposal.blockers.flatMap((row) => row.requestIds))].map((id) => (
                <li key={id}>{requestName(id)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-1 gap-3 rounded-2xl bg-muted p-4 text-[14px] sm:grid-cols-3">
            <div>
              <dt>Назначено</dt>
              <dd className="mt-1 text-[21px] font-semibold">
                {impact.assignedBefore} → {impact.assignedAfter}
              </dd>
            </div>
            <div>
              <dt>Без исполнителя</dt>
              <dd className="mt-1 text-[21px] font-semibold">+{impact.lost.length}</dd>
            </div>
            <div>
              <dt>Смена исполнителя</dt>
              <dd className="mt-1 text-[21px] font-semibold">{impact.moved.length}</dd>
            </div>
          </dl>
          {impact.criticalReasons.length ? (
            <ul
              className="mt-4 list-disc space-y-2 rounded-2xl border border-danger/30 p-4 pl-9 text-[15px]"
              aria-label="Существенные последствия"
            >
              {impact.criticalReasons.map((row) => (
                <li key={row.code}>
                  {RISK_LABELS[row.code] ?? 'Изменение требует проверки'} ({row.entityIds.length})
                </li>
              ))}
            </ul>
          ) : null}
          {impact.lost.length ? (
            <section className="mt-4">
              <h3 className="font-semibold">Останутся без назначения</h3>
              <ul className="mt-2 space-y-2 text-[14px]">
                {impact.lost.map((row) => (
                  <li key={row.requestId}>
                    {requestName(row.requestId)} — {engineerName(row.engineerId)}
                    {row.priority === 'urgent' ? ' · срочная' : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {impact.moved.length ? (
            <section className="mt-4">
              <h3 className="font-semibold">Изменение исполнителей</h3>
              <ul className="mt-2 space-y-2 text-[14px]">
                {impact.moved.map((row) => (
                  <li key={row.requestId}>
                    {requestName(row.requestId)}: {engineerName(row.fromEngineerId)} →{' '}
                    {engineerName(row.toEngineerId)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {impact.newlyLate.length ? (
            <section className="mt-4 text-[14px]">
              <h3 className="font-semibold">Завершение за пределами окна</h3>
              <ul className="mt-2 space-y-2">
                {impact.newlyLate.map((row) => (
                  <li key={row.requestId}>
                    {requestName(row.requestId)}: окно до {formatTime(row.windowEndAt)}, завершение
                    в {formatTime(row.endAt)} (+{Math.ceil(row.latenessSec / 60)} мин)
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {impact.addedEngineerIds.length ? (
            <p className="mt-4 text-[14px]">
              Дополнительные ресурсы: {impact.addedEngineerIds.map(engineerName).join(', ')}.
            </p>
          ) : null}
          {impact.delayed.length ? (
            <details className="mt-4 text-[14px]">
              <summary className="cursor-pointer font-semibold">
                Сдвиги начала работ ({impact.delayed.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {impact.delayed.map((row) => (
                  <li key={row.requestId}>
                    {requestName(row.requestId)}: {formatTime(row.beforeStartAt)} →{' '}
                    {formatTime(row.afterStartAt)} (+{Math.ceil(row.delaySec / 60)} мин)
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {impact.reorderedRoutes.map((route) => (
            <details className="mt-4 text-[14px]" key={route.engineerId}>
              <summary className="cursor-pointer font-semibold">
                Порядок: {engineerName(route.engineerId)}
              </summary>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="font-medium">Было</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    {route.beforeRequestIds.map((id) => (
                      <li key={id}>{requestName(id)}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="font-medium">Станет</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    {route.afterRequestIds.map((id) => (
                      <li key={id}>{requestName(id)}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </details>
          ))}
        </>
      )}
      {!proposal.canApply && !blocked ? (
        <p className="mt-4 text-[14px] text-danger">
          Предложение отменено или устарело. Пересчитайте его перед применением.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-[14px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-4 text-[13px] text-ink/60">
        Перед применением сервер ещё раз проверит данные и время. Новые существенные последствия
        потребуют повторного подтверждения.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button className="min-w-[180px] flex-1" disabled={busy} onClick={onCancel} variant="ink">
          {proposal.source === 'automatic' ? 'Оставить текущий план' : 'Отменить изменение'}
        </Button>
        <Button className="min-w-[160px] flex-1" disabled={busy} onClick={onRecalculate}>
          Пересчитать
        </Button>
        {proposal.canApply ? (
          <Button
            className="min-w-[220px] flex-1"
            disabled={busy}
            loading={busy}
            onClick={onConfirm}
          >
            {proposal.requiresConfirmation ? 'Подтвердить и применить' : 'Применить план'}
          </Button>
        ) : null}
      </div>
    </dialog>
  );
}
