import { motion } from 'framer-motion';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { arrivalHeadline, formatPlanTime, formatPlanWindow } from '../figma-engineer/engineerClock';
import { engineerMapsUrl } from '../figma-engineer/engineerRoute';
import { eu } from '../figma-engineer/engineerScale';
import { RequestMap } from '../figma-engineer/RequestMap';
import { CLIENT_ASSETS } from './assets';
import type { ClientRequestView } from './clientPreview';

/**
 * Figma REQUEST 115:713 — back + time-until, map, planned start, dark ticket.
 */
export function ClientRequestDetail({
  item,
  nowMs,
  notice,
  onBack,
  onChangeTime,
}: {
  item: ClientRequestView;
  nowMs: number;
  notice: string | null;
  onBack: () => void;
  onChangeTime: () => void;
}) {
  return (
    <section
      className="flex min-h-dvh flex-col"
      style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
    >
      <header className="flex items-center" style={{ gap: eu(20) }}>
        <motion.button
          type="button"
          aria-label="Назад к списку"
          onClick={onBack}
          whileTap={{ scale: 0.96 }}
          transition={{ duration: 0.16 }}
          className="flex shrink-0 items-center justify-center"
          style={{ width: eu(32), height: eu(32) }}
        >
          <FigmaIcon
            src={CLIENT_ASSETS.back}
            alt=""
            width={32}
            height={29}
            style={{ width: eu(32), height: eu(29) }}
          />
        </motion.button>
        <h1
          className="min-w-0 font-murs tracking-[-0.02em] text-figma-ink"
          style={{ fontSize: eu(40) }}
        >
          {item.status === 'en_route' ? arrivalHeadline(item.startAt, nowMs) : item.statusLabel}
        </h1>
      </header>

      <div
        className="relative shrink-0 overflow-hidden bg-white"
        style={{ marginTop: eu(36), height: eu(287), borderRadius: eu(26) }}
      >
        <RequestMap lat={item.lat} lon={item.lon} />
        <motion.button
          type="button"
          onClick={() =>
            window.open(
              engineerMapsUrl({
                lat: item.lat,
                lon: item.lon,
                addressText: item.addressText,
              }),
              '_blank',
              'noopener,noreferrer',
            )
          }
          whileTap={{ scale: 0.98 }}
          className="absolute flex items-center rounded-full bg-figma-ink"
          style={{
            right: eu(20),
            bottom: eu(20),
            gap: eu(10),
            padding: `${eu(14)} ${eu(16)} ${eu(14)} ${eu(20)}`,
          }}
        >
          <span className="whitespace-nowrap font-semibold text-white" style={{ fontSize: eu(20) }}>
            Адрес на карте
          </span>
          <FigmaIcon
            src={CLIENT_ASSETS.route}
            alt=""
            width={43}
            height={43}
            style={{ width: eu(43), height: eu(43) }}
          />
        </motion.button>
      </div>

      <div
        className="flex flex-col items-center bg-white"
        style={{
          marginTop: eu(24),
          borderRadius: eu(26),
          padding: `${eu(36)} ${eu(24)} ${eu(32)}`,
        }}
      >
        <p className="font-murs leading-none tracking-[-0.02em] text-figma-ink" style={{ fontSize: eu(72) }}>
          {formatPlanTime(item.startAt)}
        </p>
        <p
          className="font-medium text-figma-muted"
          style={{ marginTop: eu(16), fontSize: eu(22) }}
        >
          плановое начало визита
        </p>
        <span
          className="inline-flex items-center rounded-full bg-figma-track font-semibold text-figma-ink"
          style={{ marginTop: eu(20), padding: `${eu(12)} ${eu(24)}`, fontSize: eu(20) }}
        >
          Согласованное окно {formatPlanWindow(item.windowStartAt, item.windowEndAt)}
        </span>
      </div>

      <div
        className="flex flex-col bg-figma-ink"
        style={{
          marginTop: eu(24),
          borderRadius: eu(26),
          padding: `${eu(30)} ${eu(30)} ${eu(32)}`,
        }}
      >
        <div className="flex items-center" style={{ gap: eu(12) }}>
          <h2 className="font-murs tracking-[-0.02em] text-white" style={{ fontSize: eu(36) }}>
            Заявка № {item.number}
          </h2>
          <span
            className="rounded-full bg-figma-work"
            style={{ width: eu(10), height: eu(10) }}
            aria-hidden
          />
        </div>
        <p
          className="font-medium text-white/70"
          style={{ marginTop: eu(10), fontSize: eu(22) }}
        >
          {item.workTypeTitle}
        </p>
        <Chip>{item.problemTitle}</Chip>
        <Chip>{item.company}</Chip>
        <div className="flex" style={{ marginTop: eu(16), gap: eu(16) }}>
          <Chip>{streetOnly(item.addressText)}</Chip>
          {item.office ? <Chip>{item.office}</Chip> : null}
        </div>
        <Chip>{item.description}</Chip>
      </div>

      {notice ? (
        <p
          className="font-medium text-figma-muted"
          style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
        >
          {notice}
        </p>
      ) : null}

      {item.archived ? null : (
        <motion.button
          type="button"
          onClick={onChangeTime}
          whileTap={{ scale: 0.98 }}
          className="mt-auto w-full bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink"
          style={{
            marginTop: eu(28),
            height: eu(80),
            borderRadius: eu(20),
            fontSize: eu(28),
          }}
        >
          Изменить время
        </motion.button>
      )}
    </section>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <div
      className="flex min-w-0 items-center overflow-hidden bg-[#3a3c43]"
      style={{
        marginTop: eu(16),
        minHeight: eu(77),
        borderRadius: eu(20),
        padding: `${eu(20)} ${eu(20)}`,
      }}
    >
      <p
        className="min-w-0 font-medium tracking-[-0.03em] text-white"
        style={{ fontSize: eu(22), overflowWrap: 'anywhere' }}
      >
        {children}
      </p>
    </div>
  );
}

/** Drops the «Офис - » prefix so the ticket street chip matches Figma. */
function streetOnly(address: string): string {
  return address.replace(/^Офис\s+-\s+/u, '').replace(/^ул\.\s+/u, '').trim();
}
