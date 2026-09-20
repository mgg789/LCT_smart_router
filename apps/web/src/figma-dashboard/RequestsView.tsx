import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { unassignedRequests } from '../domain/dashboard';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon, FigmaText } from './primitives';
import {
  DEMO_REQUEST_ROWS,
  REQUEST_SORT_OPTIONS,
  filterRequestRows,
  requestStatusLabel,
  shortRequestId,
  rowsFromSnapshot,
  sortRequestRows,
  type RequestRowStatus,
  type RequestSortId,
  type RequestTableRow,
} from './requestsTable';

const COLUMNS = [
  { key: 'number', label: 'Номер' },
  { key: 'address', label: 'Адрес' },
  { key: 'service', label: 'Услуга' },
  { key: 'window', label: 'Окно' },
  { key: 'engineer', label: 'Инженер' },
  { key: 'status', label: 'Статус' },
] as const;

const STATUS_DOT: Record<RequestRowStatus, string> = {
  in_progress: FIGMA_ASSETS.statusWork,
  assigned: FIGMA_ASSETS.statusAssigned,
  done: FIGMA_ASSETS.statusDone,
  unassigned: FIGMA_ASSETS.statusUnassigned,
  cancelled: FIGMA_ASSETS.statusDone,
};

/**
 * Figma REQUESTS (49:6343) — full-width table on the MAIN artboard.
 */
export function RequestsView({
  snapshot,
  selectedRequestId,
  onSelect,
}: {
  snapshot: DashboardSnapshot | null;
  selectedRequestId: string | null;
  onSelect: (requestId: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [sort, setSort] = useState<RequestSortId>('usage');
  const [sortOpen, setSortOpen] = useState(false);
  const source = snapshot ? rowsFromSnapshot(snapshot) : [...DEMO_REQUEST_ROWS];
  const unassignedCount = snapshot
    ? unassignedRequests(snapshot).length
    : source.filter((row) => row.status === 'unassigned').length;
  const rows = useMemo(
    () => sortRequestRows(filterRequestRows(source, query), sort),
    [query, sort, source],
  );
  const sortLabel = REQUEST_SORT_OPTIONS.find((item) => item.id === sort)?.label ?? 'По использованию';

  useEffect(() => {
    if (!sortOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-request-sort]')) setSortOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [sortOpen]);

  return (
    <section
      className="absolute overflow-hidden rounded-[30px]"
      style={{ left: 180, top: 154, width: 1710, height: 884 }}
    >
      <FigmaText className="figma-nowrap absolute left-0 top-[30px] font-extrabold text-[48px] tracking-[-0.816px] text-figma-ink">
        Заявки
      </FigmaText>
      <FigmaText className="figma-nowrap absolute left-[189px] top-[47px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        Всего {source.length}
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.dotEngineers}
        alt=""
        width={5}
        height={5}
        className="absolute left-[276px] top-[52px]"
      />
      <FigmaText className="figma-nowrap absolute left-[291px] top-[47px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {unassignedCount} без назначения
      </FigmaText>

      <motion.label
        className="absolute left-[462px] top-[26px] flex h-[51px] w-[284px] origin-left items-center rounded-[27px] bg-white px-[16px] pr-[54px]"
        animate={
          reduceMotion
            ? undefined
            : searchFocused
              ? { scale: 1.045, boxShadow: '0 10px 28px rgba(39,41,48,0.12)' }
              : { scale: 1, boxShadow: '0 0 0 rgba(39,41,48,0)' }
        }
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="sr-only">Поиск по номеру, адресу</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder="Поиск по номеру, адресу"
          className="w-full border-0 bg-transparent font-medium text-[16px] text-figma-ink outline-none placeholder:text-figma-ink"
        />
        <motion.span
          className="pointer-events-none absolute right-[4px] top-1/2 size-[43px] -translate-y-1/2"
          animate={reduceMotion ? undefined : { scale: searchFocused ? 1.1 : 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <img alt="" src={FIGMA_ASSETS.requestSearchBg} className="absolute inset-0 size-full" />
          <img
            alt=""
            src={FIGMA_ASSETS.requestSearchGlyph}
            className="absolute left-1/2 top-1/2 size-[19px] -translate-x-1/2 -translate-y-1/2"
          />
        </motion.span>
      </motion.label>

      <div className="absolute left-[1351px] top-[31.5px]" data-request-sort>
        <motion.button
          type="button"
          onClick={() => setSortOpen((value) => !value)}
          className="flex items-center gap-[10px] rounded-[16px] px-[10px] py-[6px]"
          whileHover={reduceMotion ? undefined : { scale: 1.05 }}
          whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="figma-nowrap font-medium text-[18px] text-black">Сортировка: {sortLabel}</span>
          <motion.span
            className="flex size-[32px] items-center justify-center overflow-hidden"
            animate={{ rotate: sortOpen ? 180 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
          >
            <FigmaIcon src={FIGMA_ASSETS.sortChevron} alt="" width={18} height={10} />
          </motion.span>
        </motion.button>
        <AnimatePresence>
          {sortOpen ? (
            <motion.div
              key="request-sort-menu"
              initial={reduceMotion ? false : { opacity: 0, y: -10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="absolute right-0 top-[46px] z-20 w-[240px] origin-top-right rounded-[20px] bg-white px-[8px] py-[8px] shadow-[0_22px_48px_rgba(39,41,48,0.18)]"
            >
              {REQUEST_SORT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setSort(option.id);
                    setSortOpen(false);
                  }}
                  className={`flex h-[40px] w-full items-center rounded-[14px] px-[14px] text-left font-medium text-[16px] transition-colors duration-150 ${
                    option.id === sort
                      ? 'bg-figma-soft text-figma-ink'
                      : 'text-figma-ink hover:bg-figma-soft/70'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="absolute left-0 top-[97px] h-[767px] w-[1710px] overflow-hidden rounded-[20px] bg-white">
        <div
          className="absolute left-[31px] top-[23px] grid w-[1648px] items-center"
          style={{ gridTemplateColumns: '140px 1.15fr 1.2fr 170px 250px 220px' }}
        >
          {COLUMNS.map((column) => (
            <FigmaText
              key={column.key}
              className="figma-nowrap text-center font-semibold text-[24px] leading-none text-figma-muted"
            >
              {column.label}
            </FigmaText>
          ))}
        </div>
        <div className="absolute inset-x-0 top-[60px] bottom-0 overflow-y-auto [scrollbar-width:thin]">
          {rows.length === 0 ? (
            <p className="px-[31px] pt-[28px] text-center font-medium text-[18px] text-figma-muted">
              Заявок по запросу нет
            </p>
          ) : (
            rows.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                selected={row.id === selectedRequestId}
                onSelect={() => onSelect(row.id)}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function RequestRow({
  row,
  selected,
  onSelect,
}: {
  row: RequestTableRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full items-center border-t border-figma-track px-[31px] text-left transition-colors ${
        selected ? 'bg-figma-soft' : 'bg-white'
      }`}
      style={{
        minHeight: 68,
        gridTemplateColumns: '140px 1.15fr 1.2fr 170px 250px 220px',
      }}
    >
      <FigmaText
        className="figma-nowrap text-center font-murs text-[24px] leading-none text-figma-ink"
        title={row.id}
      >
        {shortRequestId(row.id)}
      </FigmaText>
      <p className="mx-auto line-clamp-2 max-w-[196px] text-center font-medium text-[20px] leading-[24px] text-figma-ink">
        {row.address}
      </p>
      <p className="figma-nowrap overflow-hidden text-center font-medium text-[20px] text-ellipsis text-figma-ink">
        {row.service}
      </p>
      <FigmaText className="figma-nowrap text-center font-medium text-[20px] leading-none text-figma-ink">
        {row.window}
      </FigmaText>
      <p className="figma-nowrap overflow-hidden text-center font-medium text-[20px] text-ellipsis text-figma-ink">
        {row.engineer}
      </p>
      <div className="flex justify-center">
        <StatusChip status={row.status} />
      </div>
    </button>
  );
}

function StatusChip({ status }: { status: RequestRowStatus }) {
  const label = requestStatusLabel(status);
  const tone =
    status === 'in_progress'
      ? 'bg-figma-work-bg text-figma-work'
      : status === 'done'
        ? 'bg-figma-ink text-white'
        : status === 'unassigned'
          ? 'bg-figma-bee text-figma-ink'
          : status === 'cancelled'
            ? 'bg-figma-cancel text-white'
            : 'bg-figma-track text-figma-muted';
  return (
    <span className={`inline-flex h-[42px] items-center justify-center gap-[8px] rounded-full px-[20px] ${tone}`}>
      <FigmaIcon src={STATUS_DOT[status]} alt="" width={11} height={11} />
      <span className="figma-nowrap font-medium text-[20px]">{label}</span>
    </span>
  );
}
