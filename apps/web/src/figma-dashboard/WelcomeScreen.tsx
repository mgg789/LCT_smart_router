import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { formatDayTitle } from '../lib/time';
import { useArtboardScale } from './artboardScale';
import { FIGMA_ASSETS } from './assets';
import { FIGMA_ARTBOARD, requestCountLabel } from './fixtures';
import { FigmaIcon, FigmaText } from './primitives';
import { moscowClockLabel, moscowWorkDate } from './welcomeDay';

const reveal = { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Figma Welcome 49:6785 — black NAVIX splash shown on the first morning
 * entry. Date/time and the day's request count sit under the wordmark;
 * «Начать рабочий день» opens the regular dashboard.
 */
export function WelcomeScreen({
  requestCount,
  motionOn,
  onStart,
  disabled = false,
  buttonLabel = 'Начать рабочий день',
}: {
  requestCount: number | null;
  motionOn: boolean;
  onStart: () => void | Promise<void>;
  disabled?: boolean;
  buttonLabel?: string;
}) {
  const reduceMotion = useReducedMotion();
  const animate = motionOn && !reduceMotion;
  const scale = useArtboardScale();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const dateLabel = formatDayTitle(moscowWorkDate(nowMs)).replace(/ \d{4}$/, '');
  const clock = moscowClockLabel(nowMs);
  const requests =
    requestCount === null ? 'Заявки загружаются' : `${requestCountLabel(requestCount)} на сегодня`;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black">
      <div
        className="relative shrink-0 bg-black"
        data-name="Welcome"
        style={{
          width: FIGMA_ARTBOARD.width,
          height: FIGMA_ARTBOARD.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <img
          alt=""
          src={FIGMA_ASSETS.welcomeGlobe}
          className="pointer-events-none absolute left-1/2 top-[596px] h-[699px] w-[1444px] max-w-none -translate-x-1/2 object-cover"
        />
        <motion.div
          className="absolute left-1/2 top-[59px] size-[502px] -translate-x-1/2"
          initial={animate ? { opacity: 0, y: 16 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={animate ? { ...reveal, delay: 0.04 } : { duration: 0 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.welcomeMark} alt="" width={502} height={502} />
        </motion.div>
        <motion.div
          initial={animate ? { opacity: 0, y: 12 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={animate ? { ...reveal, delay: 0.12 } : { duration: 0 }}
        >
          <FigmaText className="figma-nowrap absolute left-1/2 top-[548px] -translate-x-1/2 font-murs text-[180px] leading-none text-white">
            NAVIX
          </FigmaText>
        </motion.div>

        <motion.div
          className="absolute left-1/2 top-[720px] flex -translate-x-1/2 items-center gap-[16px]"
          initial={animate ? { opacity: 0, y: 10 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={animate ? { ...reveal, delay: 0.2 } : { duration: 0 }}
        >
          <MiniField>{`${dateLabel} · ${clock}`}</MiniField>
          <MiniField>{requests}</MiniField>
        </motion.div>

        <motion.button
          type="button"
          onClick={() => void onStart()}
          disabled={disabled}
          className="absolute left-1/2 top-[800px] flex h-[67px] w-[426px] -translate-x-1/2 items-center justify-center rounded-[20px] bg-figma-bee disabled:opacity-60"
          initial={animate ? { opacity: 0, y: 10 } : false}
          animate={{ opacity: 1, y: 0 }}
          whileHover={animate ? { scale: 1.02 } : undefined}
          whileTap={animate ? { scale: 0.98 } : undefined}
          transition={animate ? { ...reveal, delay: 0.26 } : { duration: 0 }}
        >
          <span className="figma-nowrap font-medium text-[20px] text-figma-ink">
            {buttonLabel}
          </span>
        </motion.button>
      </div>
    </div>
  );
}

function MiniField({ children }: { children: string }) {
  return (
    <div className="flex h-[56px] items-center rounded-[20px] border border-white/15 bg-white/10 px-[24px] backdrop-blur-[20px]">
      <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.3px] text-white">{children}</span>
    </div>
  );
}
