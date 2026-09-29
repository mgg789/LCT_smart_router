/**
 * The cards between sections.
 *
 * Each one is a title and one moving diagram on a flat ground, on a shared grid: 96px
 * from the frame, the word top-left, the diagram below it. Every number on a card is
 * read from the repository's own measurements (`docs/benchmarks/…`) or from the scene
 * the reel films next; nothing is invented for the card.
 */
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font, HEIGHT, MARKER_BLUE, WIDTH } from '../theme.ts';
import { Arrow, Loop, Note, Underline } from './Sketch.tsx';
import { AI_GRADIENT, Rise } from './Type.tsx';

const INK = '#141416';
const PAPER = '#f3f0e8';
const PAPER_2 = '#e7e2d6';
const LINE = 'rgba(20,20,22,0.14)';
const MUTE_INK = 'rgba(20,20,22,0.55)';
const MUTE_LIGHT = 'rgba(255,255,255,0.55)';
const PANEL = '#17191e';
const PANEL_EDGE = 'rgba(255,255,255,0.09)';
const SLATE = '#7b8190';
const ALARM = '#f72030';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Progress of a stage that starts at `delay` and runs for `length` frames. */
function stage(frame: number, delay: number, length: number): number {
  const t = clamp01((frame - delay) / length);
  return 1 - (1 - t) ** 3;
}

/** Ease-in-out progress, for things that travel rather than arrive. */
function travel(frame: number, delay: number, length: number): number {
  const t = clamp01((frame - delay) / length);
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function Brackets({ stroke }: { stroke: string }) {
  const arm = 22;
  const inset = 36;
  const edge = `2px solid ${stroke}`;
  const box = (style: CSSProperties): CSSProperties => ({
    position: 'absolute',
    width: arm,
    height: arm,
    ...style,
  });
  return (
    <>
      <div style={box({ left: inset, top: inset, borderLeft: edge, borderTop: edge })} />
      <div style={box({ right: inset, top: inset, borderRight: edge, borderTop: edge })} />
      <div style={box({ left: inset, bottom: inset, borderLeft: edge, borderBottom: edge })} />
      <div style={box({ right: inset, bottom: inset, borderRight: edge, borderBottom: edge })} />
    </>
  );
}

function Ground({ bg, dots, children }: { bg: string; dots?: string; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const out = stage(frame, durationInFrames - 10, 10);
  return (
    <AbsoluteFill style={{ backgroundColor: bg, overflow: 'hidden', opacity: 1 - out }}>
      {dots ? (
        <AbsoluteFill
          style={{
            backgroundImage: `radial-gradient(${dots} 1.1px, transparent 1.1px)`,
            backgroundSize: '22px 22px',
            backgroundPosition: `${(frame * 0.25).toFixed(2)}px 0px`,
            opacity: 0.55,
          }}
        />
      ) : null}
      <Brackets stroke={dots ? 'rgba(255,255,255,0.28)' : 'rgba(20,20,22,0.28)'} />
      {children}
    </AbsoluteFill>
  );
}

function Title({
  kicker,
  word,
  detail,
  ink,
  mute,
}: {
  kicker: string;
  word: string;
  detail: string;
  ink: string;
  mute: string;
}) {
  return (
    <div style={{ position: 'absolute', left: 96, top: 132, right: 96 }}>
      <Rise delay={0} duration={16}>
        <span
          style={{
            fontFamily: font.text,
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: '0.26em',
            textTransform: 'uppercase',
            color: mute,
          }}
        >
          {kicker}
        </span>
      </Rise>
      <Rise delay={5} duration={18} style={{ marginTop: 14 }}>
        <span
          style={{
            fontFamily: font.display,
            fontSize: 124,
            lineHeight: 0.88,
            letterSpacing: '-0.035em',
            color: ink,
          }}
        >
          {word}
        </span>
      </Rise>
      <Rise delay={12} duration={16} style={{ marginTop: 16 }}>
        <span
          style={{
            fontFamily: font.text,
            fontWeight: 500,
            fontSize: 26,
            letterSpacing: '-0.01em',
            color: mute,
          }}
        >
          {detail}
        </span>
      </Rise>
    </div>
  );
}

function Small({
  children,
  color: tint,
  style,
}: {
  children: ReactNode;
  color: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: font.text,
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: tint,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ position: 'absolute', inset: 0 }}
      aria-hidden
    >
      <title>diagram</title>
      {children}
    </svg>
  );
}

// --- ИНЖЕНЕР ---------------------------------------------------------------

/**
 * Travel-time checks from `docs/benchmarks/roads-vs-yandex-20260929`: our offline
 * forecast against Yandex Maps on the same five Moscow routes, in minutes.
 */
const ETA_CHECKS = [
  { mode: 'авто', ours: 14 + 15 / 60, yandex: 16 },
  { mode: 'авто', ours: 16 + 27 / 60, yandex: 18 },
  { mode: 'метро', ours: 22 + 5 / 60, yandex: 21 },
  { mode: 'метро', ours: 28 + 28 / 60, yandex: 32 },
  { mode: 'авто', ours: 18 + 8 / 60, yandex: 19 },
] as const;

const clock = (minutes: number) => {
  const whole = Math.floor(minutes);
  const seconds = Math.round((minutes - whole) * 60);
  return `${whole}:${String(seconds).padStart(2, '0')}`;
};

export function CardEngineer() {
  const frame = useCurrentFrame();
  const left = 96;
  const right = WIDTH - 96;
  const y = 432;
  const draw = stage(frame, 4, 34);
  const moved = travel(frame, 22, 120);
  const stops = [0.1, 0.38, 0.64, 0.9];
  const xAt = (t: number) => left + (right - left) * t;

  const base = 960;
  const tall = 330;
  const groupWidth = 196;
  const barWidth = 62;
  const chartLeft = 96;
  const deviation = interpolate(stage(frame, 70, 50), [0, 1], [0, 8]);

  return (
    <Ground bg={PAPER}>
      <Title
        kicker="Приложение"
        word="ИНЖЕНЕР"
        detail="Один клик — и он на линии"
        ink={INK}
        mute={MUTE_INK}
      />
      <Svg>
        <line x1={left} y1={y} x2={right} y2={y} stroke={LINE} strokeWidth={2} />
        <line
          x1={left}
          y1={y}
          x2={left + (right - left) * draw}
          y2={y}
          stroke={INK}
          strokeWidth={4}
          strokeLinecap="round"
        />
        {stops.map((at, index) => {
          const reached = moved >= at;
          const pop = stage(frame, 22 + at * 120, 10);
          const x = xAt(at);
          return (
            <g key={at} opacity={clamp01(draw * 3 - index * 0.4)}>
              <circle
                cx={x}
                cy={y}
                r={13 + (reached ? pop * 2 : 0)}
                fill={reached ? color.bee : PAPER}
                stroke={INK}
                strokeWidth={3}
              />
              {reached ? (
                <path
                  d={`M${x - 5} ${y} l4 4 l7 -8`}
                  fill="none"
                  stroke={INK}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - pop}
                />
              ) : null}
              <text
                x={x}
                y={y + 46}
                textAnchor="middle"
                fill={INK}
                fontFamily={font.text}
                fontSize={17}
                fontWeight={600}
              >
                {`0${index + 1}`}
              </text>
            </g>
          );
        })}
        <g transform={`translate(${xAt(moved)}, ${y})`} opacity={clamp01((frame - 20) / 6)}>
          <circle r={26 + Math.sin(frame / 5) * 3} fill={color.bee} opacity={0.28} />
          <circle r={10} fill={INK} stroke={color.bee} strokeWidth={4} />
        </g>

        {ETA_CHECKS.map((check, index) => {
          const grow = stage(frame, 40 + index * 7, 30);
          const gx = chartLeft + index * groupWidth;
          const hOurs = (check.ours / 32) * tall * grow;
          const hYa = (check.yandex / 32) * tall * grow;
          return (
            <g key={`${check.mode}-${check.yandex}`}>
              <rect x={gx} y={base - hOurs} width={barWidth} height={hOurs} rx={8} fill={INK} />
              <rect
                x={gx + barWidth + 10}
                y={base - hYa}
                width={barWidth}
                height={hYa}
                rx={8}
                fill="none"
                stroke={INK}
                strokeWidth={2.5}
                strokeDasharray="7 6"
              />
              <g opacity={clamp01((grow - 0.7) / 0.3)}>
                <text
                  x={gx + barWidth / 2}
                  y={base - hOurs - 12}
                  textAnchor="middle"
                  fontFamily={font.text}
                  fontWeight={700}
                  fontSize={16}
                  fill={INK}
                >
                  {clock(check.ours)}
                </text>
                <text
                  x={gx + barWidth * 1.5 + 10}
                  y={base - hYa - 12}
                  textAnchor="middle"
                  fontFamily={font.text}
                  fontWeight={500}
                  fontSize={16}
                  fill={MUTE_INK}
                >
                  {`${check.yandex}:00`}
                </text>
              </g>
              <text
                x={gx + barWidth + 5}
                y={base + 32}
                textAnchor="middle"
                fontFamily={font.text}
                fontWeight={600}
                fontSize={16}
                fill={MUTE_INK}
              >
                {check.mode}
              </text>
            </g>
          );
        })}
        <line x1={chartLeft} y1={base} x2={chartLeft + 5 * groupWidth - 40} y2={base} stroke={INK} strokeWidth={2} />
      </Svg>

      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 548,
          display: 'flex',
          gap: 28,
          alignItems: 'center',
          opacity: stage(frame, 36, 14),
          fontFamily: font.text,
          fontWeight: 600,
          fontSize: 17,
          color: INK,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 18, height: 18, borderRadius: 4, background: INK }} />
          Наш прогноз, офлайн
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 18, height: 18, borderRadius: 4, border: `2.5px dashed ${INK}` }} />
          Яндекс Карты
        </span>
      </div>

      <div style={{ position: 'absolute', left: 1200, top: 590, width: 620 }}>
        <Small color={MUTE_INK} style={{ opacity: stage(frame, 60, 14) }}>
          Среднее отклонение времени в пути
        </Small>
        <div
          style={{
            marginTop: 8,
            fontFamily: font.display,
            fontSize: 210,
            lineHeight: 1,
            letterSpacing: '-0.04em',
            color: INK,
            opacity: stage(frame, 66, 10),
          }}
        >
          {`${deviation.toFixed(1).replace('.', ',')}%`}
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: font.text,
            fontWeight: 500,
            fontSize: 22,
            color: MUTE_INK,
            opacity: stage(frame, 80, 14),
          }}
        >
          пять маршрутов по Москве, авто и метро
        </div>
      </div>
      <Loop centre={{ x: 1515, y: 745 }} rx={335} ry={98} at={112} draw={20} hold={400} seed={3} />
      <Note at={128} hold={400} position={{ x: 1824, y: 962 }} size={42} align="right" color={MARKER_BLUE}>
        без спутников, LIVE-данных и API пробок
      </Note>
    </Ground>
  );
}

// --- КЛИЕНТ ----------------------------------------------------------------

/** The customer's own words, as the capture types them (`capture/run.ts` STORY). */
const STORY_PARTS = [
  { text: 'У нас в офисе полностью ' },
  { text: 'пропал интернет', mark: 0 },
  { text: ', не работают кассы и телефония. Адрес: ' },
  { text: 'Москва, улица Лесная, 7', mark: 1 },
  { text: '. Меня зовут ' },
  { text: 'Иван Петров', mark: 2 },
  { text: '. Нужна помощь срочно, ' },
  { text: 'сегодня', mark: 3 },
  { text: '.' },
] as const;

const STORY_LENGTH = STORY_PARTS.reduce((total, part) => total + part.text.length, 0);

/** What the form filled in from that story, as the client take shows it. */
const FIELDS = [
  { label: 'Проблема', value: 'Интернет не работает' },
  { label: 'Адрес', value: 'Москва, улица Лесная, 7' },
  { label: 'Контакт', value: 'Иван Петров' },
  { label: 'Когда', value: 'Сегодня' },
] as const;

export function CardClient() {
  const frame = useCurrentFrame();
  const card = stage(frame, 4, 18);
  const typed = Math.floor(clamp01((frame - 12) / 78) * STORY_LENGTH);
  const caretOn = frame < 96 && Math.floor(frame / 8) % 2 === 0;

  let left = typed;
  const spans = STORY_PARTS.map((part, index) => {
    const shown = part.text.slice(0, Math.max(0, Math.min(part.text.length, left)));
    left -= part.text.length;
    const mark = 'mark' in part ? part.mark : null;
    const highlight = mark === null ? 0 : stage(frame, 94 + mark * 7, 14);
    return (
      <span
        key={`${index}-${part.text}`}
        style={
          mark === null
            ? undefined
            : {
                backgroundImage: 'linear-gradient(rgba(255,199,44,0.38), rgba(255,199,44,0.38))',
                backgroundRepeat: 'no-repeat',
                backgroundSize: `${(highlight * 100).toFixed(1)}% 100%`,
                backgroundPosition: '0 0',
                padding: '0.06em 0.08em',
                margin: '0 -0.08em',
                borderRadius: 4,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }
        }
      >
        {shown}
      </span>
    );
  });

  return (
    <Ground bg="#121316" dots="rgba(255,255,255,0.22)">
      <Title
        kicker="Заявка"
        word="КЛИЕНТ"
        detail="Рассказ своими словами становится визитом"
        ink={color.white}
        mute={MUTE_LIGHT}
      />
      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 420,
          width: 960,
          opacity: card,
          transform: `translate3d(0, ${(1 - card) * 26}px, 0)`,
          background: PANEL,
          border: `1px solid ${PANEL_EDGE}`,
          borderRadius: 26,
          padding: '26px 32px 34px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                background: 'rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: font.text,
                fontWeight: 700,
                fontSize: 15,
                color: color.white,
              }}
            >
              ИП
            </span>
            <Small color={MUTE_LIGHT}>Рассказ клиента</Small>
          </div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', height: 24 }}>
            {[0, 1, 2, 3, 4].map((bar) => (
              <span
                key={bar}
                style={{
                  width: 4,
                  borderRadius: 2,
                  background: color.bee,
                  height: frame < 92 ? 8 + Math.abs(Math.sin(frame / 4 + bar * 1.3)) * 14 : 6,
                  opacity: 0.85,
                }}
              />
            ))}
          </div>
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: font.text,
            fontWeight: 500,
            fontSize: 30,
            lineHeight: 1.42,
            color: color.white,
            minHeight: 170,
          }}
        >
          {spans}
          <span
            style={{
              display: 'inline-block',
              width: 3,
              height: 32,
              marginLeft: 2,
              verticalAlign: '-5px',
              background: color.bee,
              opacity: caretOn ? 1 : 0,
            }}
          />
        </div>
      </div>

      {FIELDS.map((field, index) => {
        const on = stage(frame, 100 + index * 8, 16);
        const top = 420 + index * 112;
        return (
          <div
            key={field.label}
            style={{
              position: 'absolute',
              left: 1210,
              top,
              width: 610,
              opacity: on,
              transform: `translate3d(${(1 - on) * 40}px, 0, 0)`,
              background: PANEL,
              border: `1px solid ${PANEL_EDGE}`,
              borderRadius: 20,
              padding: '16px 22px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                background: color.bee,
                color: INK,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: font.text,
                fontWeight: 800,
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              ✓
            </span>
            <div>
              <Small color={MUTE_LIGHT} style={{ fontSize: 12 }}>
                {field.label}
              </Small>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: font.text,
                  fontWeight: 600,
                  fontSize: 25,
                  color: color.white,
                }}
              >
                {field.value}
              </div>
            </div>
          </div>
        );
      })}
      {FIELDS.map((field, index) => (
        <Arrow
          key={`arrow-${field.label}`}
          from={{ x: 1070, y: 520 + index * 46 }}
          to={{ x: 1196, y: 462 + index * 112 }}
          bend={index < 2 ? -0.18 : 0.18}
          color={color.bee}
          width={3.5}
          at={96 + index * 8}
          draw={12}
          hold={400}
        />
      ))}
      <Note at={140} hold={400} position={{ x: 1210, y: 900 }} color={color.bee} size={48}>
        форма заполнилась сама
      </Note>
    </Ground>
  );
}

// --- ПЕРЕПЛАН --------------------------------------------------------------

type NodeId = 'd0' | 'a1' | 'a2' | 'a3' | 'd1' | 'b1' | 'b2' | 'b3' | 'd2' | 'c1' | 'c2' | 'x';

const NODES: Record<NodeId, { x: number; y: number }> = {
  d0: { x: 130, y: 520 },
  a1: { x: 320, y: 450 },
  a2: { x: 520, y: 600 },
  a3: { x: 780, y: 470 },
  d1: { x: 150, y: 770 },
  b1: { x: 360, y: 710 },
  b2: { x: 610, y: 800 },
  b3: { x: 830, y: 720 },
  d2: { x: 170, y: 930 },
  c1: { x: 430, y: 900 },
  c2: { x: 720, y: 930 },
  x: { x: 560, y: 430 },
};

/** Three crews before and after an emergency lands next to the first one's route. */
const CREWS = [
  { tint: INK, before: ['d0', 'a1', 'a2', 'a3'], after: ['d0', 'a1', 'x', 'a3'] },
  { tint: color.beeDeep, before: ['d1', 'b1', 'b2', 'b3'], after: ['d1', 'b1', 'a2', 'b2', 'b3'] },
  { tint: SLATE, before: ['d2', 'c1', 'c2'], after: ['d2', 'c1', 'c2'] },
] as const;

const path = (ids: readonly string[]) =>
  ids
    .map((id, index) => {
      const node = NODES[id as NodeId];
      return `${index === 0 ? 'M' : 'L'}${node.x} ${node.y}`;
    })
    .join(' ');

/**
 * Re-plan latency and stability from `docs/benchmarks/solver-suite-20260928`: five
 * events at 15:00 on top of an applied plan, Router Core on the M5 Pro.
 */
const REPLAN_EVENTS = [
  { name: 'Новая заявка', ms: 247.4, kept: 52 },
  { name: 'Срочная заявка', ms: 144.7, kept: 32 },
  { name: 'Инженер выпал', ms: 98.9, kept: 75 },
  { name: 'Две техостановки', ms: 102.3, kept: 84 },
  { name: 'Пробки ×3 в районе', ms: 184.8, kept: 68 },
] as const;

export function CardReplan() {
  const frame = useCurrentFrame();
  const graph = stage(frame, 4, 24);
  const alarm = stage(frame, 34, 12);
  const swap = stage(frame, 52, 40);

  return (
    <Ground bg={PAPER}>
      <Title
        kicker="День"
        word="ПЕРЕПЛАН"
        detail="Новая авария — и маршруты пересобраны"
        ink={INK}
        mute={MUTE_INK}
      />
      <Svg>
        {CREWS.map((crew) => {
          const same = crew.before.join() === crew.after.join();
          return (
            <g key={crew.tint}>
              <path
                d={path(crew.before)}
                fill="none"
                stroke={crew.tint}
                strokeWidth={6}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={same ? graph : graph * (1 - swap * 0.82)}
                strokeDasharray={same || swap < 0.05 ? undefined : '10 12'}
                pathLength={same ? undefined : 1}
              />
              {same ? null : (
                <path
                  d={path(crew.after)}
                  fill="none"
                  stroke={crew.tint}
                  strokeWidth={7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - swap}
                />
              )}
            </g>
          );
        })}
        {(Object.keys(NODES) as NodeId[])
          .filter((id) => id !== 'x')
          .map((id, index) => {
            const node = NODES[id];
            const depot = id.startsWith('d');
            const on = stage(frame, 2 + index * 1.5, 10);
            return (
              <g key={id} opacity={on}>
                {depot ? (
                  <rect x={node.x - 13} y={node.y - 13} width={26} height={26} rx={6} fill={INK} />
                ) : (
                  <circle cx={node.x} cy={node.y} r={13} fill={PAPER} stroke={INK} strokeWidth={3.5} />
                )}
              </g>
            );
          })}
        <g opacity={alarm}>
          <circle
            cx={NODES.x.x}
            cy={NODES.x.y}
            r={18 + ((frame - 34) % 30) * 1.4}
            fill="none"
            stroke={ALARM}
            strokeWidth={3}
            opacity={frame > 34 ? 1 - ((frame - 34) % 30) / 30 : 0}
          />
          <circle cx={NODES.x.x} cy={NODES.x.y} r={16 * alarm} fill={ALARM} />
        </g>
      </Svg>
      <Arrow from={{ x: 700, y: 385 }} to={{ x: 585, y: 420 }} bend={-0.3} at={40} draw={12} hold={400} />
      <Note at={40} hold={400} position={{ x: 712, y: 378 }} size={44}>
        авария
      </Note>

      <div style={{ position: 'absolute', left: 1000, top: 420, width: 824 }}>
        <Small color={MUTE_INK} style={{ opacity: stage(frame, 10, 14) }}>
          Пересчёт после события · доля плана на месте
        </Small>
        <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 22 }}>
          {REPLAN_EVENTS.map((event, index) => {
            const grow = stage(frame, 20 + index * 7, 30);
            const width = (event.ms / 247.4) * 330 * grow;
            return (
              <div
                key={event.name}
                style={{ display: 'flex', alignItems: 'center', height: 50, opacity: stage(frame, 16 + index * 7, 10) }}
              >
                <div
                  style={{
                    width: 270,
                    fontFamily: font.text,
                    fontWeight: 600,
                    fontSize: 22,
                    color: INK,
                  }}
                >
                  {event.name}
                </div>
                <div style={{ width, height: 24, borderRadius: 7, background: INK }} />
                <div
                  style={{
                    marginLeft: 14,
                    fontFamily: font.text,
                    fontWeight: 700,
                    fontSize: 21,
                    color: INK,
                    width: 110,
                    opacity: clamp01((grow - 0.6) / 0.4),
                  }}
                >
                  {`${Math.round(event.ms * grow)} мс`}
                </div>
                <div
                  style={{
                    marginLeft: 'auto',
                    fontFamily: font.text,
                    fontWeight: 600,
                    fontSize: 21,
                    color: MUTE_INK,
                    opacity: clamp01((grow - 0.6) / 0.4),
                  }}
                >
                  {`${Math.round(event.kept * grow)}%`}
                </div>
              </div>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 30,
            fontFamily: font.text,
            fontWeight: 500,
            fontSize: 17,
            color: MUTE_INK,
            opacity: stage(frame, 60, 14),
          }}
        >
          Router Core, пять событий в 15:00 поверх применённого плана, бенчмарк 28.09.2026
        </div>
      </div>
      <Loop centre={{ x: 1792, y: 704 }} rx={60} ry={32} at={96} draw={16} hold={400} seed={5} />
      <Note
        at={108}
        hold={400}
        position={{ x: 1824, y: 950 }}
        size={44}
        rotate={-3}
        align="right"
        color={MARKER_BLUE}
      >
        84% назначений остались на месте
      </Note>
    </Ground>
  );
}

// --- AI --------------------------------------------------------------------

const ASK = 'Что произошло с планом?';
const ANSWER = 'Смотрю факты сегодняшнего плана.';

/** The alert the reel solves next and the three moves the product offers on it. */
const OPTIONS = ['Написать и снять', 'Снять со смены', 'Продлить ожидание'] as const;
const PICKED = 1;

export function CardAi() {
  const frame = useCurrentFrame();
  const card = stage(frame, 4, 16);
  const asked = ASK.slice(0, Math.floor(clamp01((frame - 10) / 28) * ASK.length));
  const thinking = frame > 40 && frame < 70;
  const answered = ANSWER.slice(0, Math.floor(clamp01((frame - 70) / 34) * ANSWER.length));
  const panel = stage(frame, 30, 18);
  // The ring walks the options twice as the model weighs them, then settles.
  const scan = clamp01((frame - 58) / 70);
  const ringAt = scan < 1 ? Math.round(scan * 4) % OPTIONS.length : PICKED;
  const settled = frame >= 128;
  const orb = 1 + Math.sin(frame / 7) * 0.06;

  return (
    <Ground bg="#101114" dots="rgba(255,255,255,0.16)">
      <Title
        kicker="System One"
        word="AI"
        detail="Ответ по фактам сегодняшнего плана"
        ink={color.white}
        mute="rgba(255,255,255,0.5)"
      />
      <div
        style={{
          position: 'absolute',
          left: 262,
          top: 196,
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundImage: AI_GRADIENT,
          filter: 'blur(1px)',
          transform: `scale(${orb * stage(frame, 6, 18)}) rotate(${frame * 2}deg)`,
          opacity: 0.9,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 420,
          width: 860,
          opacity: card,
          transform: `translate3d(0, ${(1 - card) * 24}px, 0)`,
          background: PANEL,
          border: `1px solid ${PANEL_EDGE}`,
          borderRadius: 26,
          padding: '28px 30px 32px',
          minHeight: 300,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            style={{
              padding: '14px 18px',
              borderRadius: 16,
              background: '#2a2d36',
              color: color.white,
              fontFamily: font.text,
              fontWeight: 500,
              fontSize: 24,
              minHeight: 30,
              opacity: frame > 10 ? 1 : 0,
            }}
          >
            {asked}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundImage: AI_GRADIENT,
              flexShrink: 0,
              opacity: stage(frame, 38, 10),
            }}
          />
          <div
            style={{
              fontFamily: font.text,
              fontWeight: 500,
              fontSize: 26,
              lineHeight: 1.4,
              color: 'rgba(255,255,255,0.92)',
              paddingTop: 4,
            }}
          >
            {thinking ? (
              <span style={{ display: 'flex', gap: 8, paddingTop: 12 }}>
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      background: color.aiVia,
                      opacity: 0.35 + 0.65 * Math.abs(Math.sin(frame / 5 - dot * 0.8)),
                    }}
                  />
                ))}
              </span>
            ) : (
              answered
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 1060,
          top: 420,
          width: 760,
          opacity: panel,
          transform: `translate3d(${(1 - panel) * 30}px, 0, 0)`,
        }}
      >
        <Small color={MUTE_LIGHT}>Алерт · Не вышел на смену</Small>
        <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {OPTIONS.map((option, index) => {
            const ringed = frame >= 58 && index === ringAt;
            const chosen = settled && index === PICKED;
            return (
              <div
                key={option}
                style={{
                  position: 'relative',
                  padding: '20px 24px',
                  borderRadius: 18,
                  background: chosen ? color.white : PANEL,
                  color: chosen ? INK : color.white,
                  border: `1px solid ${PANEL_EDGE}`,
                  fontFamily: font.text,
                  fontWeight: 600,
                  fontSize: 25,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  boxShadow: ringed
                    ? `0 0 0 3px ${color.aiFrom}, 0 0 0 6px rgba(201,164,255,0.35)`
                    : undefined,
                }}
              >
                {option}
                {chosen ? (
                  <span style={{ fontWeight: 800, color: color.done }}>✓</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <Note at={134} hold={400} position={{ x: 1060, y: 820 }} color={color.aiVia} size={48}>
        выбор только из допустимых действий
      </Note>
    </Ground>
  );
}

// --- КОНТРОЛЬ --------------------------------------------------------------

/** Names the dispatcher actually picks. Colours are the comparison map's own. */
const POLICIES = [
  { name: 'Быстрее до клиента', swatch: '#E11D48' },
  { name: 'Бережнее к окнам', swatch: '#16A34A' },
  { name: 'Ровнее загрузка', swatch: '#D97706' },
  { name: 'Короче пробег', swatch: '#2563EB' },
] as const;

/**
 * Requests closed on the east region, same crews, from
 * `docs/benchmarks/solver-suite-20260928` (66 requests in the day).
 */
const COVERAGE = [
  { name: 'FIFO-диспетчер', done: 28, ours: false },
  { name: 'Жадный «срочность + ближайший»', done: 50, ours: false },
  { name: 'Navix Router', done: 62, ours: true },
] as const;

export function CardControl() {
  const frame = useCurrentFrame();
  const selected = Math.min(POLICIES.length - 1, Math.floor(stage(frame, 10, 50) * POLICIES.length));
  const gain = Math.round(interpolate(stage(frame, 60, 44), [0, 1], [0, 121]));

  return (
    <Ground bg={PAPER}>
      <Title
        kicker="Политики"
        word="КОНТРОЛЬ"
        detail="Один день, несколько стратегий, одни факты"
        ink={INK}
        mute={MUTE_INK}
      />
      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 408,
          right: 96,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
        }}
      >
        {POLICIES.map((policy, index) => {
          const on = stage(frame, 6 + index * 4, 14);
          const hot = index === selected;
          return (
            <div
              key={policy.name}
              style={{
                opacity: on,
                transform: `translate3d(0, ${(1 - on) * 16}px, 0) scale(${hot ? 1.02 : 1})`,
                background: hot ? INK : '#fff',
                color: hot ? color.white : INK,
                borderRadius: 16,
                padding: '16px 20px',
                border: `1px solid ${hot ? INK : PAPER_2}`,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontFamily: font.text,
                fontWeight: 600,
                fontSize: 21,
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: 6, background: policy.swatch }} />
              {policy.name}
            </div>
          );
        })}
      </div>

      <div style={{ position: 'absolute', left: 96, top: 548, width: 1180 }}>
        <Small color={MUTE_INK} style={{ opacity: stage(frame, 20, 14) }}>
          Восток · заявок закрыто из 66 · те же бригады
        </Small>
        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 26 }}>
          {COVERAGE.map((row, index) => {
            const grow = stage(frame, 28 + index * 10, 36);
            return (
              <div key={row.name}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: font.text,
                    fontWeight: 600,
                    fontSize: 21,
                    color: INK,
                    marginBottom: 10,
                    opacity: stage(frame, 24 + index * 10, 12),
                  }}
                >
                  <span>{row.name}</span>
                  <span>{`${Math.round(row.done * grow)} из 66`}</span>
                </div>
                <div style={{ height: 30, borderRadius: 9, background: PAPER_2, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${((row.done / 66) * 100 * grow).toFixed(2)}%`,
                      height: '100%',
                      borderRadius: 9,
                      background: row.ours ? color.bee : INK,
                      opacity: row.ours ? 1 : 0.8,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ position: 'absolute', left: 1360, top: 590, width: 470 }}>
        <div
          style={{
            fontFamily: font.display,
            fontSize: 124,
            lineHeight: 1,
            letterSpacing: '-0.04em',
            color: INK,
            opacity: stage(frame, 58, 10),
          }}
        >
          {`+${gain}%`}
        </div>
        <div
          style={{
            marginTop: 36,
            fontFamily: font.text,
            fontWeight: 500,
            fontSize: 22,
            lineHeight: 1.3,
            color: MUTE_INK,
            opacity: stage(frame, 70, 14),
          }}
        >
          плана дня к FIFO-диспетчеру, срочных — 11 из 13 против 2
        </div>
      </div>
      <Underline from={{ x: 1362, y: 728 }} to={{ x: 1800, y: 722 }} at={104} draw={14} hold={400} seed={7} />
      <Note at={116} hold={400} position={{ x: 1200, y: 960 }} size={46} color={MARKER_BLUE}>
        бенчмарк Router Core, 28.09
      </Note>
    </Ground>
  );
}
