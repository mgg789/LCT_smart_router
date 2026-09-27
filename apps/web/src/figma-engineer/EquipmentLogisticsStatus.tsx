import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EngineerLiveView, EquipmentLogisticsView } from '../api/live';
import { t } from '../i18n';

/** Copy follows authoritative logistics state; an unavailable planner never means infeasible. */
export function equipmentLogisticsMessage(
  entry: EquipmentLogisticsView | undefined,
  now: number,
): string {
  if (!entry || entry.state === 'searching')
    return t('figma-engineer.EquipmentLogisticsStatus.bdadd330a5');
  if (entry.state === 'assigned') {
    const minutes =
      entry.expectedAt === null ? null : Math.max(0, Math.ceil((entry.expectedAt - now) / 60));
    return t('figma-engineer.EquipmentLogisticsStatus.5deabad764', {
      value0: entry.donorName ?? t('figma-engineer.EquipmentLogisticsStatus.88d71676fa'),
      value1:
        minutes === null
          ? ''
          : minutes > 0
            ? t('figma-engineer.EquipmentLogisticsStatus.3ffc6b5291', { value0: minutes })
            : t('figma-engineer.EquipmentLogisticsStatus.a1f99cb9f9'),
    });
  }
  if (entry.state === 'error') return t('figma-engineer.EquipmentLogisticsStatus.1299e691e0');
  if (entry.state === 'none') return t('figma-engineer.EquipmentLogisticsStatus.512c8dc67e');
  if (entry.state === 'cancelled') return t('figma-engineer.EquipmentLogisticsStatus.31846ecbd1');
  return t('figma-engineer.EquipmentLogisticsStatus.1776116c54');
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
          {t('figma-engineer.EquipmentLogisticsStatus.1c5f670936')}
          {entry.state === 'assigned'
            ? t('figma-engineer.EquipmentLogisticsStatus.d620e9c7a8')
            : t('figma-engineer.EquipmentLogisticsStatus.f470d20fa5')}
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
              ? t('figma-engineer.EquipmentLogisticsStatus.42d8182b86')
              : t('figma-engineer.EquipmentLogisticsStatus.b7b111ee77')}
          </h2>
          <p aria-live="polite" className="mt-4 leading-relaxed">
            {equipmentLogisticsMessage(searching ? undefined : entry, now)}
          </p>
          <button
            type="button"
            onClick={close}
            className="mt-6 w-full rounded-full bg-figma-bee px-6 py-3 font-semibold"
          >
            {t('figma-engineer.EquipmentLogisticsStatus.e2ce86b38f')}
          </button>
        </dialog>,
        document.body,
      )}
    </>
  );
}
