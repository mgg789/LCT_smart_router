import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { eu } from '../figma-engineer/engineerScale';
import { CLIENT_ASSETS } from './assets';
import { ClientPickMap } from './ClientPickMap';
import {
  canSubmitClientForm,
  CLIENT_PROBLEMS,
  type ClientMapPoint,
  type ClientRequestDraft,
} from './clientPreview';

const tap = { duration: 0.16 };
const slideEase = [0.22, 1, 0.36, 1] as const;

/**
 * Figma FIRST 115:405 — dark new-request form with oval reason chips,
 * pickable map and an expanding map overlay (122:2471).
 */
export function ClientNewRequest({
  draft,
  notice,
  onChange,
  onSubmit,
  onAskAi,
}: {
  draft: ClientRequestDraft;
  notice: string | null;
  onChange: (next: ClientRequestDraft) => void;
  onSubmit: () => void;
  onAskAi: () => void;
}) {
  const motionOn = !useReducedMotion();
  const [mapOpen, setMapOpen] = useState(false);
  const ready = canSubmitClientForm(draft);
  const pick = (point: ClientMapPoint) => onChange({ ...draft, point });

  return (
    <section className="flex flex-col">
      <form
        className="flex flex-col bg-figma-ink"
        style={{
          marginTop: eu(24),
          borderRadius: eu(26),
          padding: `${eu(30)} ${eu(30)} ${eu(32)}`,
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h1 className="font-murs tracking-[-0.02em] text-white" style={{ fontSize: eu(36) }}>
          Новая заявка
        </h1>
        <p
          className="font-semibold text-white/60"
          style={{ marginTop: eu(12), fontSize: eu(20), lineHeight: eu(26) }}
        >
          подберём инженера и назовём точное время визита
        </p>

        <div className="flex flex-wrap" style={{ marginTop: eu(28), gap: eu(12) }}>
          {CLIENT_PROBLEMS.map((problem) => {
            const selected = draft.problem === problem;
            return (
              <motion.button
                key={problem}
                type="button"
                onClick={() => onChange({ ...draft, problem })}
                whileTap={{ scale: 0.98 }}
                transition={tap}
                aria-pressed={selected}
                className="font-medium tracking-[-0.02em] text-figma-ink"
                style={{
                  minHeight: eu(48),
                  borderRadius: eu(100),
                  padding: `${eu(14)} ${eu(24)}`,
                  fontSize: eu(20),
                  background: selected ? 'var(--color-figma-bee)' : 'var(--color-figma-track)',
                }}
              >
                {problem}
              </motion.button>
            );
          })}
        </div>

        <label className="sr-only" htmlFor="client-address">
          Адрес
        </label>
        <input
          id="client-address"
          type="text"
          autoComplete="street-address"
          placeholder="Адрес"
          value={draft.address}
          onChange={(event) => onChange({ ...draft, address: event.target.value })}
          className="w-full bg-[#555] font-medium text-white outline-none placeholder:text-white/60"
          style={{
            marginTop: eu(24),
            height: eu(80),
            borderRadius: eu(20),
            paddingInline: eu(24),
            fontSize: eu(22),
          }}
        />

        <div
          className="relative overflow-hidden bg-white"
          style={{ marginTop: eu(16), height: eu(287), borderRadius: eu(26) }}
        >
          <ClientPickMap point={draft.point} onPick={pick} />
          <motion.button
            type="button"
            aria-label="Открыть карту"
            onClick={() => setMapOpen(true)}
            whileTap={{ scale: 0.96 }}
            className="absolute"
            style={{ right: eu(14), bottom: eu(14), width: eu(50), height: eu(50) }}
          >
            <FigmaIcon
              src={CLIENT_ASSETS.expand}
              alt=""
              width={50}
              height={50}
              style={{ width: eu(50), height: eu(50) }}
            />
          </motion.button>
        </div>

        <div className="flex" style={{ marginTop: eu(24), gap: eu(16) }}>
          <ClockField
            id="client-window-start"
            label="с"
            value={draft.windowStart}
            onChange={(windowStart) => onChange({ ...draft, windowStart })}
          />
          <ClockField
            id="client-window-end"
            label="до"
            value={draft.windowEnd}
            onChange={(windowEnd) => onChange({ ...draft, windowEnd })}
          />
        </div>

        <label
          htmlFor="client-email"
          className="font-semibold text-[#f1f1f1]"
          style={{ marginTop: eu(24), fontSize: eu(32) }}
        >
          Email
        </label>
        <input
          id="client-email"
          type="email"
          autoComplete="email"
          placeholder="example@gmail.com"
          value={draft.email}
          onChange={(event) => onChange({ ...draft, email: event.target.value })}
          className="w-full bg-[#555] font-medium text-white outline-none placeholder:text-white/60"
          style={{
            marginTop: eu(12),
            height: eu(80),
            borderRadius: eu(20),
            paddingInline: eu(24),
            fontSize: eu(22),
          }}
        />

        <motion.button
          type="submit"
          disabled={!ready}
          whileTap={{ scale: 0.98 }}
          className="w-full bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-50"
          style={{
            marginTop: eu(28),
            height: eu(80),
            borderRadius: eu(20),
            fontSize: eu(28),
          }}
        >
          Отправить
        </motion.button>
        <motion.button
          type="button"
          onClick={onAskAi}
          whileTap={{ scale: 0.98 }}
          className="client-ai-border flex w-full items-center justify-center font-semibold tracking-[-0.03em]"
          style={{
            marginTop: eu(16),
            height: eu(80),
            gap: eu(12),
            borderRadius: eu(20),
            fontSize: eu(28),
          }}
        >
          <span
            aria-hidden
            className="client-ai-fill shrink-0"
            style={{
              width: eu(26),
              height: eu(26),
              WebkitMaskImage: `url(${CLIENT_ASSETS.sparkles})`,
              maskImage: `url(${CLIENT_ASSETS.sparkles})`,
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
              maskPosition: 'center',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
            }}
          />
          <span className="client-ai-fill client-ai-text">Заявка с AI</span>
        </motion.button>
      </form>

      {notice ? (
        <p
          className="font-medium text-figma-muted"
          style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
        >
          {notice}
        </p>
      ) : null}

      <AnimatePresence>
        {mapOpen ? (
          <motion.div
            key="client-map-expand"
            className="absolute inset-0 z-30 overflow-hidden bg-figma-ink"
            initial={motionOn ? { opacity: 0, scale: 0.96 } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={motionOn ? { opacity: 0, scale: 0.96 } : undefined}
            transition={motionOn ? { duration: 0.28, ease: slideEase } : { duration: 0 }}
            style={{ borderRadius: eu(26) }}
          >
            <ClientPickMap point={draft.point} onPick={pick} />
            <motion.button
              type="button"
              aria-label="Свернуть карту"
              onClick={() => setMapOpen(false)}
              whileTap={{ scale: 0.96 }}
              className="absolute flex items-center justify-center rounded-full bg-figma-ink"
              style={{
                right: eu(24),
                bottom: eu(24),
                width: eu(50),
                height: eu(50),
              }}
            >
              <FigmaIcon
                src={CLIENT_ASSETS.shrink}
                alt=""
                width={26}
                height={26}
                style={{ width: eu(26), height: eu(26) }}
              />
            </motion.button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function ClockField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <label htmlFor={id} className="font-murs text-white" style={{ fontSize: eu(24) }}>
        {label}
      </label>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="client-time-input w-full bg-[#555] font-medium text-white outline-none"
        style={{
          marginTop: eu(10),
          height: eu(80),
          borderRadius: eu(20),
          paddingInline: eu(20),
          fontSize: eu(22),
          colorScheme: 'dark',
        }}
      />
    </div>
  );
}
