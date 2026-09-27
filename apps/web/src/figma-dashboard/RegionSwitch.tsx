import { motion } from 'framer-motion';
import type { RegionSelection } from '../domain/regions';
import { t } from '../i18n';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon, FigmaText } from './primitives';

/**
 * Compact policy-style pill pinned to a map corner; width hugs the region name.
 * Shared by the day map and the policy comparison map.
 */
export function RegionSwitch({
  open,
  label,
  regions,
  selectedId,
  motionOn,
  onToggle,
  onSelect,
}: {
  open: boolean;
  label: string;
  regions: { id: RegionSelection; label: string }[];
  selectedId: RegionSelection;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (id: RegionSelection) => void;
}) {
  const listMax = 220;
  const listHeight = Math.min(regions.length * 40, listMax);
  return (
    <motion.div
      data-region-panel
      className="absolute left-[16px] top-[16px] z-30 flex w-max min-w-max flex-col overflow-hidden rounded-[27px] bg-white"
      initial={false}
      animate={{
        height: open ? 51 + listHeight + 8 : 51,
        boxShadow: open
          ? '0 22px 48px rgba(39, 41, 48, 0.18)'
          : '0 8px 22px rgba(39, 41, 48, 0.12)',
      }}
      transition={
        motionOn
          ? {
              height: { duration: 0.36, ease: [0.22, 1, 0.36, 1] },
              boxShadow: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
            }
          : { duration: 0 }
      }
    >
      <div className="flex h-[51px] w-max min-w-full shrink-0 items-center gap-[8px] pl-[16px] pr-[4px]">
        <motion.button
          type="button"
          onClick={onToggle}
          className="shrink-0 text-left"
          whileHover={motionOn ? { x: 2 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <FigmaText className="figma-nowrap font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
            {label}
          </FigmaText>
        </motion.button>
        <motion.button
          type="button"
          onClick={onToggle}
          className="size-[43px] shrink-0"
          whileHover={motionOn ? { scale: 1.08 } : undefined}
          whileTap={motionOn ? { scale: 0.96 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <motion.span
            className="flex size-[43px] origin-center items-center justify-center will-change-transform"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={motionOn ? { duration: 0.36, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.policyArrowClosed}
              alt={
                open
                  ? t('figma-dashboard.RegionSwitch.283e851233')
                  : t('figma-dashboard.RegionSwitch.6d1b736154')
              }
              width={43}
              height={43}
            />
          </motion.span>
        </motion.button>
      </div>
      {open ? (
        <div
          className="w-max min-w-full overflow-x-hidden overflow-y-auto [scrollbar-width:thin]"
          style={{ height: listHeight }}
          onWheel={(event) => event.stopPropagation()}
        >
          {regions.map((region) => (
            <motion.button
              key={region.id}
              type="button"
              onClick={() => onSelect(region.id)}
              className="flex h-[40px] w-max min-w-full items-center px-[16px] text-left"
              whileHover={motionOn ? { x: 4 } : undefined}
              transition={{ duration: 0.16 }}
            >
              <FigmaText
                className={`figma-nowrap font-medium text-[18px] ${
                  region.id === selectedId ? 'text-figma-ink' : 'text-figma-muted'
                }`}
              >
                {region.label}
              </FigmaText>
            </motion.button>
          ))}
        </div>
      ) : null}
    </motion.div>
  );
}
