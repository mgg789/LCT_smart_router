import { motion } from 'framer-motion';
import type { PlanDelta, PlanDeltaLine } from '../api/types';
import { shortRequestId } from './requestsTable';

/** Visible comparison between the previous and newly applied route plan. */
export function ReplanDeltaCard({
  delta,
  canReject,
  busy,
  motionOn,
  onAccept,
  onReject,
  onOpenRequest,
}: {
  delta: PlanDelta;
  canReject: boolean;
  busy: boolean;
  motionOn: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpenRequest: (requestId: string) => void;
}) {
  return (
    <motion.aside
      aria-label="Изменения после перепланирования"
      className="absolute left-1/2 top-1/2 z-[85] w-[640px] rounded-[24px] bg-figma-ink p-[22px] text-white shadow-[0_16px_40px_rgba(15,16,20,0.28)]"
      initial={
        motionOn ? { opacity: 0, x: '-50%', y: '-46%', scale: 0.98 } : { x: '-50%', y: '-50%' }
      }
      animate={{ opacity: 1, x: '-50%', y: '-50%', scale: 1 }}
      exit={motionOn ? { opacity: 0, x: '-50%', y: '-46%', scale: 0.98 } : { x: '-50%', y: '-50%' }}
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
        {deltaFacts(delta).map((fact) => (
          <DeltaMetric key={fact.label} label={fact.label} value={fact.value} />
        ))}
      </div>
      {delta.lines.length > 0 ? (
        <ul className="mt-4 max-h-[280px] space-y-1.5 overflow-y-auto text-[15px]">
          {delta.lines.map((line, index) => (
            <DeltaLine
              // biome-ignore lint/suspicious/noArrayIndexKey: identical delta lines can repeat; the index only breaks those ties
              key={`${line.requestId ?? line.engineerName}-${line.text}-${index}`}
              line={line}
              onOpenRequest={onOpenRequest}
            />
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

function DeltaLine({
  line,
  onOpenRequest,
}: {
  line: PlanDeltaLine;
  onOpenRequest: (requestId: string) => void;
}) {
  const label = line.requestId ? shortRequestId(line.requestId) : (line.engineerName ?? '');
  return (
    <li className="flex gap-2 leading-snug">
      {line.requestId ? (
        <button
          type="button"
          onClick={() => onOpenRequest(line.requestId ?? '')}
          className="shrink-0 font-semibold text-white underline decoration-white/40 underline-offset-2 transition-colors hover:decoration-white"
        >
          {label}
        </button>
      ) : (
        <span className="shrink-0 font-semibold text-white">{label}</span>
      )}
      <span className="text-white/70">: {line.text}</span>
    </li>
  );
}

/** Numbers a dispatcher can compare without opening the plan. Missing fields stay hidden. */
function deltaFacts(delta: PlanDelta): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (delta.assignedBefore !== undefined && delta.assignedAfter !== undefined) {
    facts.push({
      label: 'Назначено',
      value: `${delta.assignedBefore} → ${delta.assignedAfter}`,
    });
  }
  facts.push({
    label: 'Без назначения',
    value: `${delta.slaBefore} → ${delta.slaAfter}`,
  });
  facts.push({ label: 'Передано', value: String(delta.transferred) });
  facts.push({ label: 'Сдвинуто', value: String(delta.shifted) });
  if (delta.distanceBeforeKm !== undefined && delta.distanceAfterKm !== undefined) {
    facts.push({
      label: 'Пробег, км',
      value: `${formatKm(delta.distanceBeforeKm)} → ${formatKm(delta.distanceAfterKm)}`,
    });
  }
  if (delta.engineersBefore !== undefined && delta.engineersAfter !== undefined) {
    facts.push({
      label: 'Инженеры',
      value: `${delta.engineersBefore} → ${delta.engineersAfter}`,
    });
  }
  return facts;
}

function formatKm(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function DeltaMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[16px] bg-white/10 px-3 py-3">
      <p className="text-[13px] text-white/60">{label}</p>
      <p className="mt-1 text-[22px] font-semibold">{value}</p>
    </div>
  );
}
