import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { formatRange } from '@/shared/lib';
import { StatusPill } from '@/shared/ui';
import type { RequestSort } from '../model/requestRows';
import { buildRequestRows, filterRows, sortRows } from '../model/requestRows';

const SORT_OPTIONS: { value: RequestSort; label: string }[] = [
  { value: 'window', label: 'По окну' },
  { value: 'status', label: 'По статусу' },
  { value: 'engineer', label: 'По инженеру' },
  { value: 'address', label: 'По адресу' },
];

/** Column layout of the mockup's table. */
const COLUMNS = 'grid-cols-[130px_1fr_1fr_150px_1fr_260px]';

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

  const requests = requestsQuery.data?.requests ?? [];
  const rows = useMemo(
    () =>
      buildRequestRows(
        requests,
        stateQuery.data?.plan ?? null,
        engineersQuery.data?.engineers ?? [],
      ),
    [requests, stateQuery.data?.plan, engineersQuery.data?.engineers],
  );
  const visible = useMemo(() => sortRows(filterRows(rows, query), sort), [rows, query, sort]);

  const failed = requestsQuery.isError || stateQuery.isError || engineersQuery.isError;
  const loading = requestsQuery.isPending || stateQuery.isPending || engineersQuery.isPending;

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать заявки. Проверьте, что System Layer запущен.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-6">
        <h1 className="font-display text-[40px] text-ink">Заявки</h1>
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

        <label className="ml-auto flex items-center gap-2 text-[18px] text-ink">
          Сортировка:
          <select
            className="cursor-pointer bg-transparent text-[18px] text-ink outline-none"
            onChange={(event) => setSort(event.target.value as RequestSort)}
            value={sort}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-surface">
        <div
          className={`sticky top-0 z-10 grid ${COLUMNS} items-center gap-4 border-ink/10 border-b bg-surface px-8 py-5 text-center text-[20px] text-ink/50`}
        >
          <span className="text-left">Номер</span>
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
              <span className="text-left font-semibold text-[22px]">{row.number}</span>
              <span>{row.addressText}</span>
              <span>{row.serviceTitle}</span>
              <span>{formatRange(row.windowStartAt, row.windowEndAt)}</span>
              <span>{row.engineerName ?? '—'}</span>
              <span className="flex flex-wrap items-center justify-center gap-2 whitespace-nowrap">
                {row.urgent ? (
                  <span className="rounded-full bg-accent px-3 py-1 text-[14px] font-semibold">
                    Срочная
                  </span>
                ) : null}
                <StatusPill tone={row.statusTone}>{row.statusTitle}</StatusPill>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
