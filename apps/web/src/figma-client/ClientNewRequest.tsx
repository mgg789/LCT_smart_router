import { motion } from 'framer-motion';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { engineerMapsUrl } from '../figma-engineer/engineerRoute';
import { eu } from '../figma-engineer/engineerScale';
import { RequestMap } from '../figma-engineer/RequestMap';
import { CLIENT_ASSETS } from './assets';
import {
  canSubmitClientForm,
  CLIENT_PROBLEMS,
  type ClientRequestDraft,
} from './clientPreview';

const tap = { duration: 0.16 };

/**
 * Figma FIRST 115:344 — dark new-request form. Field heights follow the
 * engineer phone tokens, not the undersized Figma artboard.
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
  const ready = canSubmitClientForm(draft);
  const mapPoint = { lat: 55.7558, lon: 37.6173, addressText: draft.address.trim() };

  return (
    <section className="flex flex-col">
      <div className="flex flex-col items-center" style={{ marginTop: eu(28), gap: eu(16) }}>
        <FigmaIcon
          src={CLIENT_ASSETS.logo}
          alt=""
          width={170}
          height={170}
          style={{ width: eu(140), height: eu(140) }}
        />
        <p className="font-murs tracking-[0.02em] text-figma-ink" style={{ fontSize: eu(48) }}>
          NAVIX
        </p>
      </div>

      <form
        className="flex flex-col bg-figma-ink"
        style={{
          marginTop: eu(36),
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
          className="font-medium text-white/70"
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
                className="font-medium tracking-[-0.02em] text-white"
                style={{
                  minHeight: eu(56),
                  borderRadius: eu(20),
                  padding: `${eu(14)} ${eu(24)}`,
                  fontSize: eu(20),
                  background: selected ? 'rgba(255, 199, 44, 0.16)' : '#3a3c43',
                  border: selected ? `${eu(3)} solid var(--color-figma-bee)` : `${eu(2)} solid transparent`,
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
          className="w-full bg-[#3a3c43] font-medium text-white outline-none placeholder:text-white/45"
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
          style={{ marginTop: eu(16), height: eu(287), borderRadius: eu(20) }}
        >
          <RequestMap lat={mapPoint.lat} lon={mapPoint.lon} />
          <motion.button
            type="button"
            onClick={() => window.open(engineerMapsUrl(mapPoint), '_blank', 'noopener,noreferrer')}
            whileTap={{ scale: 0.98 }}
            className="absolute flex items-center rounded-full bg-figma-ink"
            style={{
              left: eu(16),
              bottom: eu(16),
              padding: `${eu(14)} ${eu(24)}`,
            }}
          >
            <span className="whitespace-nowrap font-semibold text-white" style={{ fontSize: eu(20) }}>
              Указать на карте
            </span>
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
          className="font-medium text-white"
          style={{ marginTop: eu(24), fontSize: eu(22) }}
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
          className="w-full bg-[#3a3c43] font-medium text-white outline-none placeholder:text-white/45"
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
          className="flex w-full items-center justify-center font-semibold tracking-[-0.03em] text-white"
          style={{
            marginTop: eu(16),
            height: eu(80),
            gap: eu(12),
            borderRadius: eu(20),
            border: `${eu(2)} solid rgba(255,255,255,0.35)`,
            fontSize: eu(28),
          }}
        >
          <FigmaIcon
            src={CLIENT_ASSETS.sparkles}
            alt=""
            width={26}
            height={26}
            className="brightness-0 invert"
            style={{ width: eu(26), height: eu(26) }}
          />
          Заявка с AI
        </motion.button>
      </form>

      <label
        className="flex items-start"
        style={{ marginTop: eu(24), gap: eu(16) }}
      >
        <input
          type="checkbox"
          checked={draft.consent}
          onChange={(event) => onChange({ ...draft, consent: event.target.checked })}
          className="shrink-0 accent-figma-ink"
          style={{ width: eu(30), height: eu(30), marginTop: eu(4) }}
        />
        <span className="font-medium text-figma-dim" style={{ fontSize: eu(18), lineHeight: eu(24) }}>
          Я согласен(а) на обработку данных и получение уведомлений по email
        </span>
      </label>

      {notice ? (
        <p
          className="font-medium text-figma-muted"
          style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
        >
          {notice}
        </p>
      ) : null}
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
      <label htmlFor={id} className="font-medium text-white" style={{ fontSize: eu(20) }}>
        {label}
      </label>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full bg-[#3a3c43] font-medium text-white outline-none"
        style={{
          marginTop: eu(10),
          height: eu(80),
          borderRadius: eu(20),
          paddingInline: eu(20),
          fontSize: eu(22),
        }}
      />
    </div>
  );
}
