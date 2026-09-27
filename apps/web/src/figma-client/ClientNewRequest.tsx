import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useWorkTypes } from '../api/workTypes';
import { WorkTypePicker } from '../components/WorkTypePicker';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { eu } from '../figma-engineer/engineerScale';
import { CLIENT_ASSETS } from './assets';
import { ClientPickMap } from './ClientPickMap';
import {
  type ClientGeocodeHit,
  interpretClientStory,
  reverseClientPoint,
  searchClientAddress,
} from './clientApi';
import {
  CLIENT_PROBLEM_WORK,
  CLIENT_PROBLEMS,
  type ClientMapPoint,
  type ClientProblem,
  type ClientRequestDraft,
} from './clientPreview';

const STORY_KEY = 'lct.client.story';
const STORY_PLACEHOLDER = 'Расскажите, что у вас случилось, когда к вам приехать, ваше ФИО и email';

const slideEase = [0.22, 1, 0.36, 1] as const;

/**
 * Figma FIRST 115:405 — dark new-request form with a work-type selector,
 * pickable map and an expanding map overlay (122:2471).
 */
export function ClientNewRequest({
  draft,
  busy = false,
  notice,
  initialMode = 'form',
  onChange,
  onSubmit,
}: {
  draft: ClientRequestDraft;
  busy?: boolean;
  notice: string | null;
  /** Allows an explicit entry mode; the structured form is the default. */
  initialMode?: 'story' | 'form';
  onChange: (next: ClientRequestDraft) => void;
  onSubmit: () => void;
}) {
  const motionOn = !useReducedMotion();
  const catalogue = useWorkTypes();
  const selectedCode =
    draft.workType ?? (draft.problem ? CLIENT_PROBLEM_WORK[draft.problem].workType : '');
  const emergency =
    catalogue.rows.find((row) => row.code === selectedCode)?.category === 'emergency';
  const [mode, setMode] = useState<'story' | 'form'>(initialMode);
  const [story, setStory] = useState('');
  const [listening, setListening] = useState(false);
  const [tracing, setTracing] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [hits, setHits] = useState<ClientGeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const draftRef = useRef(draft);
  const onChangeRef = useRef(onChange);
  const typing = useRef(false);
  const searchGen = useRef(0);
  const pickGen = useRef(0);
  draftRef.current = draft;
  onChangeRef.current = onChange;
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    noticeRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORY_KEY);
    if (saved) setStory(saved);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORY_KEY, story);
  }, [story]);

  const speech = useRef<SpeechHandle | null>(null);
  useEffect(
    () => () => {
      speech.current?.stop();
    },
    [],
  );

  useEffect(() => {
    if (!typing.current) return;
    const query = draft.address.trim();
    if (query.length < 3) {
      setHits([]);
      setSearching(false);
      return;
    }
    const generation = ++searchGen.current;
    setSearching(true);
    const handle = window.setTimeout(() => {
      void searchClientAddress(query)
        .then((found) => {
          if (generation !== searchGen.current || !typing.current) return;
          const next = found.slice(0, 4);
          setHits(next);
          const first = next[0];
          if (!first) return;
          onChangeRef.current({
            ...draftRef.current,
            point: { lat: first.lat, lon: first.lon },
          });
        })
        .catch(() => {
          if (generation === searchGen.current) setHits([]);
        })
        .finally(() => {
          if (generation === searchGen.current) setSearching(false);
        });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [draft.address]);

  const chooseHit = (hit: ClientGeocodeHit) => {
    typing.current = false;
    searchGen.current += 1;
    setHits([]);
    setSearching(false);
    onChange({
      ...draftRef.current,
      address: hit.displayName,
      point: { lat: hit.lat, lon: hit.lon },
    });
  };

  const pick = (point: ClientMapPoint) => {
    const generation = ++pickGen.current;
    searchGen.current += 1;
    typing.current = false;
    setHits([]);
    setSearching(false);
    onChange({ ...draftRef.current, point });
    const coordinates = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
    void reverseClientPoint(point)
      .then((hit) => {
        if (generation !== pickGen.current) return;
        onChangeRef.current({
          ...draftRef.current,
          address: hit?.displayName ?? coordinates,
          point: hit ? { lat: hit.lat, lon: hit.lon } : point,
        });
      })
      .catch(() => {
        if (generation !== pickGen.current) return;
        onChangeRef.current({ ...draftRef.current, address: coordinates, point });
      });
  };

  const toggleDictation = () => {
    if (listening) {
      speech.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) => {
      const said = [...Array(event.results.length).keys()]
        .map((index) => event.results[index]?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (said) setStory(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    speech.current = rec;
    setListening(true);
    rec.start();
  };

  const revealForm = () => {
    const local = { ...draftRef.current };
    setTracing(false);
    setMode('form');
    onChange(local);
    void interpretClientStory(story)
      .then((picked) => {
        if (draftRef.current !== local) return;
        const problem = CLIENT_PROBLEMS.includes(picked.problem as ClientProblem)
          ? (picked.problem as ClientProblem)
          : local.problem;
        onChange({
          ...local,
          problem,
          workType: picked.workType,
          workTypeTitle: catalogue.rows.find((row) => row.code === picked.workType)?.title,
          contactName: picked.contactName,
          email: picked.email,
          windowStart: picked.windowStart,
          windowEnd: picked.windowEnd,
          address: picked.address,
          point: picked.address === local.address ? local.point : null,
        });
      })
      .catch(() => undefined);
  };

  const sendStory = () => {
    if (tracing || story.trim().length === 0) return;
    if (!motionOn) {
      revealForm();
      return;
    }
    setTracing(true);
  };

  const storyRadius = eu(28);
  const canSend = story.trim().length > 0;
  return (
    <section
      className={mode === 'form' ? 'flex shrink-0 flex-col' : 'flex min-h-0 flex-1 flex-col'}
    >
      {mode === 'story' ? (
        <div className="flex flex-1 items-center justify-center px-[12px]">
          <p
            className="text-center font-murs tracking-[-0.03em] text-figma-ink"
            style={{ fontSize: eu(40), lineHeight: eu(48) }}
          >
            Расскажите о проблеме
          </p>
        </div>
      ) : (
        <div className="shrink-0" style={{ height: `calc(${eu(36)} + 28px)` }} />
      )}
      <div className="flex flex-col">
        <ModeSwitch mode={mode} onChange={setMode} />
        <AnimatePresence initial={false}>
          {mode === 'story' ? (
            <motion.div
              key="story"
              className=""
              initial={motionOn ? { opacity: 0, y: 24 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={motionOn ? { opacity: 0, y: 16 } : undefined}
              transition={motionOn ? { duration: 0.36, ease: slideEase } : { duration: 0 }}
            >
              <div
                className="relative bg-white"
                style={{
                  borderRadius: storyRadius,
                  minHeight: eu(180),
                  border: '1.5px solid rgba(39,41,48,0.14)',
                  boxShadow: '0 10px 28px rgba(39,41,48,0.08)',
                }}
              >
                <textarea
                  value={story}
                  onChange={(event) => setStory(event.target.value)}
                  placeholder={STORY_PLACEHOLDER}
                  rows={4}
                  className="w-full resize-none bg-transparent font-medium text-figma-ink outline-none placeholder:text-figma-muted"
                  style={{
                    minHeight: eu(180),
                    borderRadius: storyRadius,
                    padding: `${eu(18)} ${eu(20)} ${eu(64)} ${eu(20)}`,
                    fontSize: eu(20),
                    lineHeight: eu(28),
                  }}
                />
                <button
                  type="button"
                  aria-label={listening ? 'Остановить диктовку' : 'Диктовка'}
                  aria-pressed={listening}
                  onClick={toggleDictation}
                  className="absolute flex items-center justify-center"
                  style={{
                    left: eu(16),
                    bottom: eu(16),
                    width: eu(44),
                    height: eu(44),
                    color: listening ? 'var(--color-figma-bee)' : 'var(--color-figma-ink)',
                  }}
                >
                  <Mic size={22} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label="Отправить рассказ"
                  disabled={tracing || !canSend}
                  onClick={sendStory}
                  className="absolute flex items-center justify-center rounded-full text-white"
                  style={{
                    right: eu(16),
                    bottom: eu(16),
                    width: eu(48),
                    height: eu(48),
                    background: canSend ? 'var(--color-figma-ink)' : '#d7d7d7',
                    color: canSend ? '#fff' : '#8d8d8d',
                  }}
                >
                  <ArrowRight size={22} strokeWidth={2} />
                </button>
                {tracing ? <PerimeterTrace onDone={revealForm} /> : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {mode === 'form' ? (
            <motion.div
              key="form"
              className="overflow-hidden"
              style={{ paddingBottom: eu(48) }}
              initial={motionOn ? { height: 0, opacity: 0 } : false}
              animate={{ height: 'auto', opacity: 1 }}
              exit={motionOn ? { height: 0, opacity: 0 } : undefined}
              transition={motionOn ? { duration: 0.48, ease: slideEase } : { duration: 0 }}
            >
              <form
                className="flex flex-col bg-figma-ink"
                style={{
                  marginTop: eu(24),
                  borderRadius: eu(26),
                  padding: `${eu(30)} ${eu(30)} ${eu(32)}`,
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (catalogue.rows.some((row) => row.code === selectedCode)) onSubmit();
                }}
              >
                <div>
                  <WorkTypePicker
                    showEmergencyAction={false}
                    rows={catalogue.rows}
                    value={selectedCode}
                    error={catalogue.error}
                    onRetry={catalogue.retry}
                    onChange={(workType) => {
                      const selected = catalogue.rows.find((row) => row.code === workType);
                      onChange({
                        ...draft,
                        workType,
                        workTypeTitle: selected?.title,
                        problem: selected?.category === 'emergency' ? 'Авария' : 'Другое...',
                      });
                    }}
                  />
                </div>

                <label
                  htmlFor="client-name"
                  className="font-semibold text-[#f1f1f1]"
                  style={{ marginTop: eu(24), fontSize: eu(24) }}
                >
                  ФИО
                </label>
                <input
                  id="client-name"
                  type="text"
                  autoComplete="name"
                  placeholder="Иван Иванов"
                  value={draft.contactName}
                  onChange={(event) => onChange({ ...draft, contactName: event.target.value })}
                  className="w-full bg-[#555] font-medium text-white outline-none placeholder:text-white/60"
                  style={{
                    marginTop: eu(12),
                    height: eu(80),
                    borderRadius: eu(20),
                    paddingInline: eu(24),
                    fontSize: eu(22),
                  }}
                />

                <label className="sr-only" htmlFor="client-address">
                  Адрес
                </label>
                <input
                  id="client-address"
                  type="text"
                  autoComplete="street-address"
                  placeholder="Адрес"
                  value={draft.address}
                  onChange={(event) => {
                    typing.current = true;
                    onChange({ ...draft, address: event.target.value, point: null });
                  }}
                  className="w-full bg-[#555] font-medium text-white outline-none placeholder:text-white/60"
                  style={{
                    marginTop: eu(24),
                    height: eu(80),
                    borderRadius: eu(20),
                    paddingInline: eu(24),
                    fontSize: eu(22),
                  }}
                />
                {searching ? (
                  <p
                    className="font-medium text-white/60"
                    style={{ marginTop: eu(8), fontSize: eu(16) }}
                  >
                    Ищем адрес…
                  </p>
                ) : null}
                {hits.length > 0 ? (
                  <ul className="flex flex-col" style={{ marginTop: eu(8), gap: eu(6) }}>
                    {hits.map((hit) => (
                      <li key={`${hit.lat}:${hit.lon}:${hit.displayName}`}>
                        <button
                          type="button"
                          onClick={() => chooseHit(hit)}
                          className="w-full bg-white text-left font-medium text-figma-ink"
                          style={{
                            borderRadius: eu(16),
                            padding: `${eu(12)} ${eu(16)}`,
                            fontSize: eu(18),
                            lineHeight: eu(24),
                          }}
                        >
                          {hit.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

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

                {!emergency ? (
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
                ) : null}

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

                {notice ? (
                  <p
                    ref={noticeRef}
                    className={`font-medium ${busy ? 'text-white/70' : 'text-[#ffb4b4]'}`}
                    style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
                  >
                    {notice}
                  </p>
                ) : null}
                <motion.button
                  type="submit"
                  disabled={busy || !catalogue.rows.some((row) => row.code === selectedCode)}
                  whileTap={{ scale: 0.98 }}
                  className="w-full bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-50"
                  style={{
                    marginTop: notice ? eu(12) : eu(28),
                    height: eu(80),
                    borderRadius: eu(20),
                    fontSize: eu(28),
                  }}
                >
                  {busy ? 'Отправляем…' : 'Отправить'}
                </motion.button>
              </form>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

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

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: 'story' | 'form';
  onChange: (next: 'story' | 'form') => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Способ заявки"
      className="relative flex bg-white"
      style={{
        marginBottom: eu(14),
        height: eu(52),
        borderRadius: eu(100),
        padding: eu(4),
      }}
    >
      <motion.span
        aria-hidden
        className="absolute bg-figma-bee"
        initial={false}
        animate={{ left: mode === 'story' ? eu(4) : 'calc(50% + 0px)' }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        style={{ top: eu(4), bottom: eu(4), width: `calc(50% - ${eu(4)})`, borderRadius: eu(100) }}
      />
      {(
        [
          ['story', 'Авто'],
          ['form', 'Форма'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          onClick={() => onChange(id)}
          className="relative z-10 flex-1 font-semibold text-figma-ink"
          style={{ fontSize: eu(18) }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PerimeterTrace({ onDone }: { onDone: () => void }) {
  const ref = useRef<SVGRectElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const node = ref.current;
    const box = node?.closest('div');
    if (!node || !box) return;
    const width = box.clientWidth;
    const height = box.clientHeight;
    const radius = Number.parseFloat(getComputedStyle(box).borderRadius) || 0;
    node.setAttribute('width', String(Math.max(0, width - 4)));
    node.setAttribute('height', String(Math.max(0, height - 4)));
    node.setAttribute('rx', String(Math.max(0, radius - 2)));
    const length = node.getTotalLength();
    node.style.strokeDasharray = `${length}`;
    node.style.strokeDashoffset = `${length}`;
    const animation = node.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
      duration: 1400,
      easing: 'linear',
      fill: 'forwards',
    });
    const timer = window.setTimeout(() => done.current(), 1400);
    return () => {
      animation.cancel();
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="client-story-trace" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7794f2" />
          <stop offset="55%" stopColor="#f93a48" />
          <stop offset="100%" stopColor="#7794f2" />
        </linearGradient>
      </defs>
      <rect
        ref={ref}
        x="2"
        y="2"
        width="100%"
        height="100%"
        rx="18"
        pathLength={100}
        fill="none"
        stroke="url(#client-story-trace)"
        strokeWidth="3"
        strokeDasharray="100"
        strokeDashoffset="100"
        style={{ width: 'calc(100% - 4px)', height: 'calc(100% - 4px)' }}
      />
    </svg>
  );
}

interface SpeechResultEvent extends Event {
  results: ArrayLike<ArrayLike<{ transcript: string } | undefined> | undefined>;
}

interface SpeechHandle {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function speechCtor(): (new () => SpeechHandle) | null {
  if (typeof window === 'undefined') return null;
  const host = window as Window & {
    SpeechRecognition?: new () => SpeechHandle;
    webkitSpeechRecognition?: new () => SpeechHandle;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}
