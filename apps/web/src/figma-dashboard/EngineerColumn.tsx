import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import { useArtboardStretch } from './artboardStretch';
import { FIGMA_ASSETS } from './assets';
import { engineerPortrait } from './engineerPortrait';
import { type EngineerCard, requestCountLabel, truncateEnd } from './fixtures';
import { FigmaIcon, FigmaText } from './primitives';
import { TintIcon } from './TintIcon';
import { TRANSPORT_ICONS } from './transport';

const SEARCH_CONTROL_SIZE = 40;
const SEARCH_OPEN_WIDTH = 351;
const PANEL_TOP = 154 - 16;
const PANEL_HEIGHT = 893 + 16;
const UNASSIGNED_TOP = 778 + 16;
const PROGRESS_TRACK = 321;
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };
const springQuick = { type: 'spring' as const, stiffness: 420, damping: 36, mass: 0.8 };

/** Displays the engineer roster, search control, progress rows, and unassigned summary. */
export function EngineerColumn({
  engineers,
  totalCount,
  requestCount,
  totalKm,
  planLabel,
  unassignedTitle,
  unassignedReason,
  selectedEngineerId,
  searchOpen,
  searchQuery,
  motionOn,
  onSearchToggle,
  onSearchChange,
  onSelect,
  onSelectUnassigned,
}: {
  engineers: EngineerCard[];
  totalCount: number;
  requestCount: number;
  totalKm: number;
  planLabel: string;
  unassignedTitle: string;
  unassignedReason: string;
  selectedEngineerId: string | null;
  searchOpen: boolean;
  searchQuery: string;
  motionOn: boolean;
  onSearchToggle: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onSelectUnassigned: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Read top to bottom, so spare height is worth more here than spare width.
  const { dy } = useArtboardStretch();

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  return (
    <section
      className="absolute left-[180px] w-[411px] overflow-hidden rounded-[20px] bg-white"
      style={{ top: PANEL_TOP, height: PANEL_HEIGHT + dy }}
    >
      <div className="absolute left-[30px] top-[30px] z-0 flex items-center">
        <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
          {requestCountLabel(requestCount)}
        </FigmaText>
        <FigmaIcon
          src={FIGMA_ASSETS.dotEngineers}
          alt=""
          width={5}
          height={5}
          className="mx-[10px]"
        />
        <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
          {totalKm}
          {t('figma-dashboard.EngineerColumn.31d1742659')}
        </FigmaText>
      </div>
      <FigmaText className="figma-nowrap absolute left-[30px] top-[68px] z-0 font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {planLabel}
      </FigmaText>
      <div
        className="absolute left-[30px] right-[30px] top-[114px] z-0 h-[48px]"
        data-engineer-search
      >
        <AnimatePresence initial={false}>
          {!searchOpen ? (
            <motion.div
              key="title"
              className="absolute inset-y-0 left-0 flex items-center"
              initial={motionOn ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fadeSoft}
            >
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                {t('figma-dashboard.EngineerColumn.960ef88466')}
              </FigmaText>
              <FigmaIcon
                src={FIGMA_ASSETS.dotEngineers}
                alt=""
                width={5}
                height={5}
                className="mx-[10px]"
              />
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                {totalCount}
              </FigmaText>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div
          className="absolute right-0 top-[calc(50%-2px)] box-border flex -translate-y-1/2 items-center overflow-hidden rounded-[20px] border border-solid border-figma-ink bg-white"
          style={{
            height: SEARCH_CONTROL_SIZE,
            minHeight: SEARCH_CONTROL_SIZE,
            maxHeight: SEARCH_CONTROL_SIZE,
          }}
          initial={false}
          animate={{ width: searchOpen ? SEARCH_OPEN_WIDTH : SEARCH_CONTROL_SIZE }}
          transition={motionOn ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        >
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('figma-dashboard.EngineerColumn.6614a726f7')}
            tabIndex={searchOpen ? 0 : -1}
            aria-hidden={!searchOpen}
            className="box-border h-full min-h-0 min-w-0 flex-1 border-0 bg-transparent py-0 pl-[18px] pr-[40px] font-medium leading-none text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint"
          />
          <button
            type="button"
            aria-label={
              searchOpen
                ? t('figma-dashboard.EngineerColumn.28b28dba9e')
                : t('figma-dashboard.EngineerColumn.6614a726f7')
            }
            onClick={onSearchToggle}
            className="absolute right-0 top-0 flex items-center justify-center"
            style={{ width: SEARCH_CONTROL_SIZE, height: SEARCH_CONTROL_SIZE }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.searchPanel}
              alt=""
              width={22}
              height={22}
              className="translate-x-[1px] -translate-y-[1px]"
            />
          </button>
        </motion.div>
      </div>
      <div className="absolute inset-x-0 top-[158px] bottom-[132px] z-20 overflow-y-auto px-[30px] pt-[12px] [scrollbar-width:thin]">
        <div className="flex flex-col gap-[20px] pb-[8px]">
          <AnimatePresence initial={false}>
            {engineers.map((engineer, index) => (
              <motion.div
                key={engineer.id}
                layout
                initial={motionOn ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={motionOn ? springQuick : { duration: 0 }}
                className="relative"
                style={{ zIndex: index === 0 ? 30 : 10 }}
                whileHover={{ zIndex: 40 }}
              >
                <EngineerRow
                  engineer={engineer}
                  selected={engineer.id === selectedEngineerId}
                  elevate={index === 0}
                  motionOn={motionOn}
                  onSelect={() => onSelect(engineer.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {engineers.length === 0 ? (
            <p className="pt-[24px] text-center font-medium text-[16px] text-figma-muted">
              {t('figma-dashboard.EngineerColumn.ff236a6635')}
            </p>
          ) : null}
        </div>
      </div>
      <motion.button
        type="button"
        onClick={onSelectUnassigned}
        className="absolute left-[30px] z-30 flex w-[351px] flex-col items-center justify-center overflow-clip rounded-[20px] bg-figma-bee px-[29px] py-[25px]"
        style={{ top: UNASSIGNED_TOP + dy }}
        whileHover={motionOn ? { scale: 1.01 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <FigmaText className="figma-nowrap font-murs text-[20px] tracking-[0.2px] text-figma-ink">
          {unassignedTitle}
        </FigmaText>
        <FigmaText className="figma-nowrap mt-[6px] font-semibold text-[16px] tracking-[0.16px] text-figma-sub">
          {unassignedReason}
        </FigmaText>
      </motion.button>
    </section>
  );
}

function EngineerRow({
  engineer,
  selected,
  elevate,
  motionOn,
  onSelect,
}: {
  engineer: EngineerCard;
  selected: boolean;
  elevate: boolean;
  motionOn: boolean;
  onSelect: () => void;
}) {
  const transportIcon = TRANSPORT_ICONS[engineer.transportType ?? ''];
  const progress = Math.max(
    8,
    Math.round(
      (engineer.requestCount === 0 ? 1 : engineer.doneCount / engineer.requestCount) *
        PROGRESS_TRACK,
    ),
  );

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={motionOn ? { y: -2, zIndex: 40 } : undefined}
      className={`relative box-border h-[132px] w-[351px] overflow-visible rounded-[15px] text-left transition-[box-shadow,background-color] duration-200 ease-out ${
        selected ? 'bg-figma-soft' : 'bg-transparent'
      } ${elevate ? 'z-30' : 'z-10'}`}
      style={{ boxShadow: selected ? 'inset 0 0 0 1px #727478' : 'inset 0 0 0 1px transparent' }}
    >
      <img
        alt=""
        src={engineerPortrait(engineer.id, engineer.name)}
        className="absolute left-[15px] top-[20px] size-[44px] max-w-none rounded-full object-cover"
      />
      <div className="absolute left-[69px] right-[15px] top-[20px] z-20 flex items-center justify-between gap-[10px]">
        <span
          className="figma-nowrap min-w-0 flex-1 overflow-hidden font-murs text-[20px] leading-[26px] tracking-[0.1px] text-ellipsis text-black"
          title={engineer.name}
        >
          {truncateEnd(engineer.name)}
        </span>
        <FigmaText className="figma-nowrap shrink-0 font-bold text-[16px] tracking-[0.16px] text-black">
          {engineer.km}
          {t('figma-dashboard.EngineerColumn.31d1742659')}
        </FigmaText>
      </div>
      <div className="absolute left-[69px] top-[49px] flex items-center gap-[8px] font-medium text-[16px] tracking-[-0.272px] text-figma-muted">
        <span className="figma-nowrap flex items-center gap-[4px]">
          {transportIcon ? <TintIcon src={transportIcon} color="currentColor" size={18} /> : null}
          {engineer.status}
        </span>
        <span className="size-[3px] rounded-full bg-figma-muted" />
        <span className="figma-nowrap">
          {engineer.requestCount}
          {t('figma-dashboard.EngineerColumn.a7b7ba4108')}
        </span>
      </div>
      <div className="absolute left-[15px] top-[81px] h-[8px] w-[321px] rounded-[13px] bg-figma-track" />
      <motion.div
        className={`absolute left-[15px] top-[81px] h-[8px] rounded-[13px] ${engineer.lineFailed ? 'bg-figma-cancel' : engineer.doneCount === engineer.requestCount ? 'bg-figma-done' : 'bg-figma-ink'}`}
        initial={false}
        animate={{ width: progress }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      />
      <FigmaText className="figma-nowrap absolute left-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        {engineer.shift}
      </FigmaText>
      <FigmaText className="figma-nowrap absolute right-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        {engineer.lineLabel ??
          t('figma-dashboard.EngineerColumn.8197005f1b', {
            value0: engineer.doneCount,
            value1: engineer.requestCount,
          })}
      </FigmaText>
    </motion.button>
  );
}
