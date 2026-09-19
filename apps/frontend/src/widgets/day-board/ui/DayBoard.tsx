import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { activeRequests, unassignedRequests } from '@/entities/request';
import { cn, formatKm, formatRange, formatTime } from '@/shared/lib';
import { Monogram } from '@/shared/ui';
import type { EngineerRow } from '../model/engineerRows';
import { buildEngineerRows } from '../model/engineerRows';

export interface DayBoardProps {
  engineers: EngineerView[];
  requests: RequestView[];
  plan: PlanView | null;
  selectedEngineerId: string | null;
  onSelectEngineer: (engineerId: string) => void;
  onShowUnassigned: () => void;
}

function EngineerCard({
  row,
  selected,
  onSelect,
}: {
  row: EngineerRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const progress = row.assignedCount > 0 ? row.doneCount / row.assignedCount : 0;

  return (
    <button
      aria-pressed={selected}
      className={cn(
        'w-full rounded-2xl px-4 py-3 text-left transition-colors',
        selected ? 'bg-surface ring-1 ring-ink/15' : 'hover:bg-muted/60',
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-center gap-3">
        <Monogram name={row.name} size={40} />
        <span className="min-w-0 flex-1 truncate font-display text-[18px] text-ink">
          {row.name}
        </span>
        <span className="shrink-0 text-[16px] text-ink">
          {row.distanceKm === null ? '—' : formatKm(row.distanceKm)}
        </span>
      </div>

      <p className="mt-1 pl-[52px] text-[14px] text-ink/55">
        {row.availability === 'offline' ? 'не на смене' : 'в работе'} · {row.assignedCount} заявок
      </p>

      <div className="mt-3 h-[6px] w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-ink" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="mt-2 flex items-center justify-between text-[14px] text-ink/55">
        <span>
          {row.shiftStartAt !== null && row.shiftEndAt !== null
            ? formatRange(row.shiftStartAt, row.shiftEndAt)
            : 'смена не задана'}
        </span>
        <span>
          выполнено {row.doneCount}/{row.assignedCount}
        </span>
      </div>
    </button>
  );
}

/**
 * Left column of the day: how much work there is, the crews working it, and a way
 * into whatever the router could not place.
 *
 * Counts come from the requests, not from the plan: the plan says what should
 * happen and the requests say what the day actually holds.
 */
export function DayBoard({
  engineers,
  requests,
  plan,
  selectedEngineerId,
  onSelectEngineer,
  onShowUnassigned,
}: DayBoardProps) {
  const [query, setQuery] = useState('');

  const rows = useMemo(
    () => buildEngineerRows(engineers, plan, requests),
    [engineers, plan, requests],
  );
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [rows, query]);

  const dayRequests = activeRequests(requests);
  const unassigned = unassignedRequests(requests);

  return (
    <section // 411px is the drawn width; below the 1920 the mockup assumes, the column
      // gives way rather than squeezing the map out of the screen.
      className="flex h-full min-h-0 shrink basis-[411px] flex-col rounded-[20px] bg-surface p-5 min-w-[320px]"
    >
      <h2 className="font-display text-[24px] text-ink">{dayRequests.length} заявки</h2>
      <p className="mt-1 text-[14px] text-ink/55">
        {unassigned.length} без назначения
        {plan ? ` · план от ${formatTime(plan.planAsOf)}` : ' · план ещё не применён'}
      </p>

      <div className="mt-5 flex items-center gap-3">
        <h3 className="font-display text-[20px] text-ink">Инженеры · {rows.length}</h3>
        <label className="ml-auto flex items-center gap-2 text-ink/55">
          <Search aria-hidden size={18} />
          <span className="sr-only">Поиск инженера</span>
          <input
            className="w-[120px] bg-transparent text-[14px] text-ink outline-none placeholder:text-ink/40"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск"
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {visibleRows.map((row) => (
          <EngineerCard
            key={row.engineerId}
            onSelect={() => onSelectEngineer(row.engineerId)}
            row={row}
            selected={row.engineerId === selectedEngineerId}
          />
        ))}
        {visibleRows.length === 0 ? (
          <p className="px-4 py-6 text-[14px] text-ink/55">Никто не найден.</p>
        ) : null}
      </div>

      {unassigned.length > 0 ? (
        <button
          className="mt-4 shrink-0 rounded-2xl bg-accent px-4 py-4 text-center"
          onClick={onShowUnassigned}
          type="button"
        >
          <span className="block font-display text-[18px] text-ink">
            {unassigned.length} заявок без назначения
          </span>
          <span className="mt-1 block text-[14px] text-ink/70">Посмотреть причины</span>
        </button>
      ) : null}
    </section>
  );
}
