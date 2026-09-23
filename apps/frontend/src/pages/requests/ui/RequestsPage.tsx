import { AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { failedWithoutData } from '@/shared/api';
import { cn, formatDayTitle, formatRange } from '@/shared/lib';
import { Popover, StatusPill } from '@/shared/ui';
import type { RequestSort } from '../model/requestRows';
import { buildRequestRows, filterRows, sortRows } from '../model/requestRows';

const SORT_OPTIONS: { value: RequestSort; label: string }[] = [
  { value: 'window', label: 'По окну' },
  { value: 'status', label: 'По статусу' },
  { value: 'engineer', label: 'По инженеру' },
  { value: 'address', label: 'По адресу' },
];

/** Column layout of the mockup's table. */
const COLUMNS = 'grid-cols-[130px_1fr_1fr_150px_1fr_220px]';

/**
 * The day's requests as a table: number, address, service, window, crew, status.
 *
 * Search and sorting are client-side — the contract offers no query parameters
 * beyond `lifecycle` and `assignment`, and the whole day is already in memory.
 */
export function RequestsPage() {
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();
  const engineersQuery = useEngineers();

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<RequestSort>('window');
  const [sortOpen, setSortOpen] = useState(false);

  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;
  const rows = useMemo(
    () => buildRequestRows(requests, plan, engineersQuery.data?.engineers ?? []),
    [requests, plan, engineersQuery.data?.engineers],
  );
  const visible = useMemo(() => sortRows(filterRows(rows, query), sort), [rows, query, sort]);

  const failed = [requestsQuery, stateQuery, engineersQuery].some(failedWithoutData);
  const loading = requestsQuery.isPending || stateQuery.isPending || engineersQuery.isPending;
  const dayAnchor = plan?.planAsOf ?? requests[0]?.windowStartAt ?? null;
  const sortLabel = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? '';

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать заявки. Проверьте, что System Layer запущен.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="font-display text-[32px] text-ink">
        {dayAnchor === null ? 'День' : formatDayTitle(dayAnchor)}
      </h1>

      <div className="mt-[26px] flex flex-wrap items-center gap-6">
        <h2 className="font-display text-[40px] text-ink">Заявки</h2>
        <p className="text-[18px] text-ink/50">
          Всего {rows.length} · {unassignedRequests(requests).length} без назначения
        </p>

        <label className="flex h-12 items-center gap-3 rounded-full bg-surface pr-1 pl-5">
          <span className="sr-only">Поиск по номеру, адресу</span>
          <input
            className="w-[240px] bg-transparent text-[16px] text-ink outline-none placeholder:text-ink/40"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по номеру, адресу"
            type="search"
            value={query}
          />
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-full bg-ink text-white"
          >
            <Search size={20} />
          </span>
        </label>

        <div className="relative ml-auto">
          <button
            aria-expanded={sortOpen}
            aria-haspopup="dialog"
            className="flex h-[43px] items-center gap-2 pr-1 text-[18px] text-ink"
            onClick={() => setSortOpen((open) => !open)}
            type="button"
          >
            Сортировка: {sortLabel}
            {/* The arrow turns over while the panel is open, as the drawing does. */}
            {sortOpen ? <ChevronUp aria-hidden size={20} /> : <ChevronDown aria-hidden size={20} />}
          </button>

          <AnimatePresence>
            {sortOpen ? (
              <Popover
                className="-top-1 -right-1"
                key="sort"
                origin="right"
                closeIcon={<ChevronUp aria-hidden size={20} />}
                closeLabel="Закрыть сортировку"
                onClose={() => setSortOpen(false)}
                title="Сортировка"
                width={280}
              >
                <fieldset className="border-0 p-0">
                  <legend className="sr-only">Порядок заявок</legend>
                  {SORT_OPTIONS.map((option) => (
                    <label
                      className="flex h-[44px] cursor-pointer items-center gap-[10px]"
                      key={option.value}
                    >
                      <span className="relative inline-flex size-[24px] shrink-0">
                        <input
                          checked={sort === option.value}
                          className="peer size-[24px] cursor-pointer appearance-none rounded-full border-2 border-ink"
                          name="requests-sort"
                          onChange={() => {
                            setSort(option.value);
                            setSortOpen(false);
                          }}
                          type="radio"
                        />
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 m-auto hidden size-[12px] rounded-full bg-ink peer-checked:block"
                        />
                      </span>
                      <span
                        className={cn(
                          'text-[18px] font-medium text-ink',
                          sort === option.value && 'font-semibold',
                        )}
                      >
                        {option.label}
                      </span>
                    </label>
                  ))}
                </fieldset>
              </Popover>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-surface">
        <div
          className={`sticky top-0 z-10 grid ${COLUMNS} items-center gap-4 border-ink/10 border-b bg-surface px-8 py-5 text-center text-[20px] text-ink/50`}
        >
          <span>Номер</span>
          <span>Адрес</span>
          <span>Услуга</span>
          <span>Окно</span>
          <span>Инженер</span>
          <span>Статус</span>
        </div>

        {loading ? <p className="p-8 text-[16px] text-ink/55">Загружаем заявки…</p> : null}

        {!loading && visible.length === 0 ? (
          <p className="p-8 text-[16px] text-ink/55">
            {rows.length === 0 ? 'Заявок на этот день нет.' : 'Ничего не найдено.'}
          </p>
        ) : null}

        <ul>
          {visible.map((row) => (
            <li
              className={`grid ${COLUMNS} items-center gap-4 border-ink/10 border-b px-8 py-4 text-center text-[18px] text-ink last:border-b-0`}
              key={row.id}
            >
              <span className="font-bold text-[26px] text-ink">{row.number}</span>
              <span>{row.addressText}</span>
              <span>{row.serviceTitle}</span>
              <span>{formatRange(row.windowStartAt, row.windowEndAt)}</span>
              <span>{row.engineerName ?? '—'}</span>
              <span className="flex justify-center">
                <StatusPill tone={row.statusTone}>{row.statusTitle}</StatusPill>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
