import { motion } from 'framer-motion';
import type { PlanDelta } from '../api/types';

/** Visible comparison between the previous and newly applied route plan. */
export function ReplanDeltaCard({
  delta,
  canReject,
  busy,
  motionOn,
  onAccept,
  onReject,
}: {
  delta: PlanDelta;
  canReject: boolean;
  busy: boolean;
  motionOn: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <motion.aside
      aria-label="Изменения после перепланирования"
      className="absolute bottom-[28px] left-[623px] z-[85] w-[520px] rounded-[24px] bg-figma-ink p-[22px] text-white shadow-2xl"
      initial={motionOn ? { opacity: 0, y: 24, scale: 0.98 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={motionOn ? { opacity: 0, y: 16, scale: 0.98 } : undefined}
      transition={motionOn ? { duration: 0.32, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[16px] font-semibold text-white/60">Перепланирование завершено</p>
          <h2 className="mt-1 font-murs text-[25px] tracking-[0.01em]">Что изменилось</h2>
        </div>
        <span className="rounded-full bg-white/10 px-3 py-2 text-[14px] font-semibold">
          {(delta.solveMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <DeltaMetric label="Передано" value={delta.transferred} />
        <DeltaMetric label="Сдвинуто" value={delta.shifted} />
        <DeltaMetric label="Риски SLA" value={`${delta.slaBefore} → ${delta.slaAfter}`} />
      </div>
      {delta.notes.length > 0 ? (
        <ul className="mt-4 space-y-1 text-[15px] text-white/70">
          {delta.notes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-5 flex gap-3">
        {canReject ? (
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="min-h-11 flex-1 rounded-full border border-white/25 px-4 font-semibold disabled:opacity-50"
          >
            Вернуть прежний план
          </button>
        ) : null}
        <button
          type="button"
          onClick={onAccept}
          className="min-h-11 flex-1 rounded-full bg-figma-bee px-4 font-semibold text-figma-ink"
        >
          Понятно
        </button>
      </div>
    </motion.aside>
  );
}

function DeltaMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[16px] bg-white/10 px-3 py-3">
      <p className="text-[13px] text-white/60">{label}</p>
      <p className="mt-1 text-[22px] font-semibold">{value}</p>
    </div>
  );
}
