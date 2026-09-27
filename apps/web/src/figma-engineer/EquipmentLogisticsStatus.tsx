import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EngineerLiveView, EquipmentLogisticsView } from '../api/live';

/** Copy follows authoritative logistics state; an unavailable planner never means infeasible. */
export function equipmentLogisticsMessage(
  entry: EquipmentLogisticsView | undefined,
  now: number,
): string {
  if (!entry || entry.state === 'searching')
    return 'Ищем оборудование у коллег. Пожалуйста, оставайтесь на заявке.';
  if (entry.state === 'assigned') {
    const minutes =
      entry.expectedAt === null ? null : Math.max(0, Math.ceil((entry.expectedAt - now) / 60));
    return `${entry.donorName ?? 'Инженер'} привезёт вам оборудование${minutes === null ? '' : minutes > 0 ? ` через ${minutes} мин` : ' в ближайшее время'}. Пожалуйста, ждите. Время ожидания добавлено к заявке.`;
  }
  if (entry.state === 'error')
    return 'Планировщик временно недоступен. Заявка остаётся в работе. Сообщите диспетчеру; состояние обновится после восстановления связи.';
  if (entry.state === 'none')
    return 'Подходящей доставки оборудования не найдено. Заявка завершена с проблемой.';
  if (entry.state === 'cancelled')
    return 'Доставка оборудования отменена. Уточните дальнейшие действия у диспетчера.';
  return 'Оборудование доставлено. Можно продолжать работу; время выполнения заявки уточнено.';
}

/** Receiver-only status survives route updates and remains dismissible during network failures. */
export function EquipmentLogisticsStatus({
  live,
  now,
  searching,
  requestId,
}: {
  live: EngineerLiveView;
  now: number;
  searching: boolean;
  requestId: string | null;
}) {
  // The API stores one logistics record per request and workday.
  const entry = (live.logistics ?? []).find(
    (item) =>
      item.kind === 'donor_delivery' &&
      item.receiverEngineerId === live.engineer.id &&
      item.requestId === requestId,
  );
  const key = searching ? `pending:${requestId}` : entry ? `${entry.id}:${entry.state}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = key !== null && key !== dismissed;
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) node.showModal();
    else if (!open && node?.open) node.close();
  }, [open]);
  const close = () => setDismissed(key);
  if (typeof document === 'undefined') return null;
  return (
    <>
      {entry && ['assigned', 'searching', 'error'].includes(entry.state) && !open ? (
        <button
          type="button"
          onClick={() => setDismissed(null)}
          className="fixed bottom-4 left-4 right-4 z-40 rounded-2xl bg-figma-bee p-4 font-semibold text-figma-ink"
        >
          Оборудование: {entry.state === 'assigned' ? 'ожидаем доставку' : 'проверить статус'}
        </button>
      ) : null}
      {createPortal(
        <dialog
          ref={dialog}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          aria-labelledby="equipment-logistics-title"
          className="m-auto w-[min(90vw,560px)] rounded-3xl border-0 bg-white p-6 text-figma-ink backdrop:bg-figma-ink/50"
        >
          <h2 id="equipment-logistics-title" className="font-murs text-2xl">
            {searching || entry?.state === 'searching'
              ? 'Ищем оборудование'
              : 'Оборудование для заявки'}
          </h2>
          <p aria-live="polite" className="mt-4 leading-relaxed">
            {equipmentLogisticsMessage(searching ? undefined : entry, now)}
          </p>
          <button
            type="button"
            onClick={close}
            className="mt-6 w-full rounded-full bg-figma-bee px-6 py-3 font-semibold"
          >
            Понятно
          </button>
        </dialog>,
        document.body,
      )}
    </>
  );
}
