import { motion } from 'framer-motion';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { formatMinutesRu, formatPlanTime, formatPlanWindow } from '../figma-engineer/engineerClock';
import { eu } from '../figma-engineer/engineerScale';
import { RequestMap } from '../figma-engineer/RequestMap';
import { CLIENT_ASSETS } from './assets';
import { type ClientRequestView, splitClientRequests } from './clientPreview';

/**
 * Figma MAIN 115:204 — live card, «Новая заявка», archive list.
 * Card geometry matches engineer Upcoming / Regular tokens.
 */
export function ClientRequests({
  requests,
  notice,
  motionOn,
  onOpen,
  onNewRequest,
}: {
  requests: readonly ClientRequestView[];
  notice: string | null;
  motionOn: boolean;
  onOpen: (id: string) => void;
  onNewRequest: () => void;
}) {
  const { featured, rest, archive } = splitClientRequests(requests);

  return (
    <>
      <h1
        className="font-extrabold tracking-[0.02em] text-figma-ink"
        style={{ marginTop: eu(48), fontSize: eu(36) }}
      >
        Список заявок
      </h1>
      {notice ? (
        <p
          className="font-medium text-figma-muted"
          style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
        >
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col" style={{ marginTop: eu(20), gap: eu(20) }}>
        {featured ? (
          <FeaturedCard
            item={featured}
            motionOn={motionOn}
            delay={0}
            onOpen={() => onOpen(featured.id)}
          />
        ) : (
          <p className="font-medium text-figma-muted" style={{ fontSize: eu(20) }}>
            Активных заявок нет
          </p>
        )}
        {rest.map((item, index) => (
          <ArchiveCard
            key={item.id}
            item={item}
            motionOn={motionOn}
            delay={(index + 1) * 0.04}
            onOpen={() => onOpen(item.id)}
          />
        ))}
      </div>

      <motion.button
        type="button"
        onClick={onNewRequest}
        whileTap={{ scale: 0.98 }}
        className="w-full bg-figma-ink font-semibold tracking-[-0.03em] text-white"
        style={{
          marginTop: eu(28),
          height: eu(80),
          borderRadius: eu(20),
          fontSize: eu(28),
        }}
      >
        Новая заявка
      </motion.button>

      <h2
        className="font-extrabold tracking-[0.02em] text-figma-ink"
        style={{ marginTop: eu(36), fontSize: eu(36) }}
      >
        Архив
      </h2>
      <div className="flex flex-col" style={{ marginTop: eu(20), gap: eu(20) }}>
        {archive.map((item, index) => (
          <ArchiveCard
            key={item.id}
            item={item}
            motionOn={motionOn}
            delay={index * 0.04}
            onOpen={() => onOpen(item.id)}
          />
        ))}
      </div>
    </>
  );
}

function FeaturedCard({
  item,
  motionOn,
  delay,
  onOpen,
}: {
  item: ClientRequestView;
  motionOn: boolean;
  delay: number;
  onOpen: () => void;
}) {
  return (
    <motion.article
      initial={motionOn ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay } : { duration: 0 }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: Card contains an independent map thumb and cannot wrap a button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }}
        className="overflow-hidden border-solid border-figma-bee bg-white text-left"
        style={{
          borderRadius: eu(20),
          borderWidth: eu(3),
          padding: `${eu(22)} ${eu(24)} ${eu(24)}`,
        }}
      >
        <div className="flex items-start justify-between" style={{ gap: eu(16) }}>
          <div className="min-w-0 flex-1">
            <p
              className="font-murs leading-none tracking-[-0.02em] text-figma-ink"
              style={{ fontSize: eu(40) }}
            >
              {formatPlanTime(item.startAt)}
            </p>
            <p
              className="break-words font-semibold tracking-[-0.02em] text-figma-dim"
              style={{ marginTop: eu(14), fontSize: eu(24) }}
            >
              {item.addressText}
            </p>
            <div
              className="flex flex-wrap items-center font-medium tracking-[-0.02em] text-figma-muted"
              style={{ marginTop: eu(12), columnGap: eu(10), rowGap: eu(4), fontSize: eu(20) }}
            >
              <span>{item.workTypeTitle}</span>
              <FigmaIcon
                src={CLIENT_ASSETS.dot}
                alt=""
                width={4}
                height={4}
                style={{ width: eu(4), height: eu(4) }}
              />
              <span>{formatMinutesRu(item.durationSec)}</span>
            </div>
            <span
              className="inline-flex items-center rounded-full bg-figma-bee font-semibold text-figma-ink"
              style={{ marginTop: eu(16), padding: `${eu(10)} ${eu(24)}`, fontSize: eu(20) }}
            >
              Открыть карточку
            </span>
          </div>
          <MapThumb lat={item.lat} lon={item.lon} />
        </div>
        {item.engineerName ? (
          <div
            className="flex items-center justify-between"
            style={{ marginTop: eu(20), gap: eu(16) }}
          >
            <div className="flex min-w-0 items-center" style={{ gap: eu(16) }}>
              <img
                alt=""
                src={item.engineerPortrait ?? CLIENT_ASSETS.portrait}
                className="shrink-0 rounded-full object-cover"
                style={{ width: eu(70), height: eu(70) }}
              />
              <div className="min-w-0">
                <p className="font-semibold text-figma-ink" style={{ fontSize: eu(22) }}>
                  {item.engineerName}
                </p>
                {item.engineerEtaLabel ? (
                  <p
                    className="font-medium text-figma-muted"
                    style={{ marginTop: eu(6), fontSize: eu(18) }}
                  >
                    {item.engineerEtaLabel}
                  </p>
                ) : null}
              </div>
            </div>
            <StatusPill label={item.statusLabel} live={item.status === 'en_route'} />
          </div>
        ) : (
          <div style={{ marginTop: eu(16) }}>
            <StatusPill label={item.statusLabel} live={item.status === 'en_route'} />
          </div>
        )}
      </div>
    </motion.article>
  );
}

function ArchiveCard({
  item,
  motionOn,
  delay,
  onOpen,
}: {
  item: ClientRequestView;
  motionOn: boolean;
  delay: number;
  onOpen: () => void;
}) {
  return (
    <motion.article
      initial={motionOn ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay } : { duration: 0 }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: Card contains an independent map thumb and cannot wrap a button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }}
        className="flex w-full items-start justify-between overflow-hidden text-left"
        style={{
          gap: eu(16),
          borderRadius: eu(20),
          padding: `${eu(25)} ${eu(30)}`,
          background: 'rgba(255, 255, 255, 0.7)',
        }}
      >
        <div className="min-w-0 flex-1">
          <p
            className="font-murs leading-none tracking-[-0.02em] text-figma-ink/70"
            style={{ fontSize: eu(40) }}
          >
            {formatPlanTime(item.startAt)}
          </p>
          <p
            className="break-words font-semibold tracking-[-0.02em] text-figma-dim/70"
            style={{ marginTop: eu(14), fontSize: eu(24) }}
          >
            {item.addressText}
          </p>
          <p
            className="font-medium tracking-[-0.02em] text-figma-muted"
            style={{ marginTop: eu(12), fontSize: eu(20) }}
          >
            {item.workTypeTitle}
          </p>
          <span
            className="inline-flex items-center rounded-full bg-figma-ink/70 font-semibold text-white"
            style={{
              marginTop: eu(16),
              padding: `${eu(7)} ${eu(30)}`,
              fontSize: eu(22),
            }}
          >
            {formatPlanWindow(item.windowStartAt, item.windowEndAt)}
          </span>
        </div>
        <MapThumb lat={item.lat} lon={item.lon} />
      </div>
    </motion.article>
  );
}

function StatusPill({ label, live }: { label: string; live: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-semibold ${
        live ? 'bg-figma-work-bg text-figma-work' : 'bg-figma-track text-figma-dim'
      }`}
      style={{ padding: `${eu(8)} ${eu(18)}`, gap: eu(8), fontSize: eu(18) }}
    >
      <span
        className={`rounded-full ${live ? 'bg-figma-work' : 'bg-figma-muted'}`}
        style={{ width: eu(11), height: eu(11) }}
      />
      {label}
    </span>
  );
}

function MapThumb({ lat, lon }: { lat: number; lon: number }) {
  return (
    <div
      className="pointer-events-none relative shrink-0 overflow-hidden bg-figma-soft"
      style={{ width: eu(170), height: eu(164), borderRadius: eu(20) }}
    >
      <RequestMap lat={lat} lon={lon} />
    </div>
  );
}
