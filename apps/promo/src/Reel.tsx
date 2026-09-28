/**
 * The reel.
 *
 * Shots are cut against the marks the capture left on each take, not against counted
 * seconds, so a take that runs long does not slide the edit. Everything on screen inside
 * a shot is the running product; the camera, the cursor, the cards between sections and
 * the desk at the end are the only things this file draws.
 *
 * Where the storyboard asks for a move rather than a cut — pushing into the map that is
 * already on screen, pressing a notice and pulling back to the panel it opened, walking
 * the header from the policy pill to the metrics dialog — the shot is one unbroken
 * stretch of one take and the camera does the work. Those places are marked below,
 * because splitting one of them back into two shots is exactly what made the first pass
 * of this reel flash.
 */
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import type { ReactNode } from 'react';
import { AbsoluteFill, Audio, staticFile } from 'remotion';
import type { CameraKey } from './components/Camera.tsx';
import { Caption, Grade } from './components/Caption.tsx';
import { CardAi, CardClient, CardControl, CardEngineer, CardReplan } from './components/Cards.tsx';
import { Footage, PhoneFootage } from './components/Footage.tsx';
import { WordCard } from './components/Type.tsx';
import { flash, pushThrough, whip } from './components/transitions.tsx';
import { hasShot, mark, shot } from './footage.ts';
import { Intro } from './scenes/Intro.tsx';
import { Outro } from './scenes/Outro.tsx';
import { color, FONT_FACES } from './theme.ts';

const sec = (value: number) => Math.round(value * 60);

/** Seconds between two marks on the same take, with a floor so a shot is never empty. */
function span(scene: string, from: string, to: string, fallback: number): number {
  if (!hasShot(scene)) return fallback;
  const length = mark(scene, to, 0) - mark(scene, from, 0);
  return length > 0.2 ? length : fallback;
}

/** Seconds from a mark to the end of the take — for a shot that runs a take out. */
function tail(scene: string, from: string, fallback: number): number {
  if (!hasShot(scene)) return fallback;
  const length = shot(scene).duration - mark(scene, from, 0);
  return length > 0.2 ? length : fallback;
}

/** Playback speed that fits `length` seconds of a take into `into` seconds of reel. */
const fit = (length: number, into: number) => Math.max(1, length / into);

function Card({ children }: { children: ReactNode }) {
  return (
    <AbsoluteFill style={{ backgroundColor: color.stage }}>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(60% 52% at 50% 46%, rgba(255,199,44,0.09) 0%, rgba(8,9,11,0) 72%)',
        }}
      />
      {children}
    </AbsoluteFill>
  );
}

/** A take that has not been filmed yet leaves a legible gap instead of a crash. */
function Missing({ scene }: { scene: string }) {
  return (
    <Card>
      <WordCard word={scene} kicker="нет материала" size={0.11} />
    </Card>
  );
}

function Desk({ children, ...props }: Parameters<typeof Footage>[0]) {
  if (!hasShot(props.scene)) return <Missing scene={props.scene} />;
  return (
    <Footage {...props}>
      <Grade />
      {children}
    </Footage>
  );
}

function Phone({ children, ...props }: Parameters<typeof PhoneFootage>[0]) {
  if (!hasShot(props.scene)) return <Missing scene={props.scene} />;
  return (
    <PhoneFootage {...props}>
      <Grade />
      {children}
    </PhoneFootage>
  );
}

// --- where things sit inside a take, in that take's own coordinates ---------
//
// Read off the captured frames once; the reel aims the camera with these.

/** Dispatcher take, filmed at 2880x1620. */
const DESK_AT = {
  startButton: { cx: 0.5, cy: 0.772 },
  lockup: { cx: 0.5, cy: 0.4 },
  map: { cx: 0.66, cy: 0.54 },
  mapTight: { cx: 0.7, cy: 0.5 },
  crewColumn: { cx: 0.2, cy: 0.5 },
  toastCorner: { cx: 0.87, cy: 0.16 },
  header: { cx: 0.66, cy: 0.1 },
  policyPanel: { cx: 0.74, cy: 0.36 },
  metricsButton: { cx: 0.57, cy: 0.12 },
  rail: { cx: 0.12, cy: 0.42 },
  centre: { cx: 0.5, cy: 0.5 },
  alertCard: { cx: 0.44, cy: 0.36 },
  modal: { cx: 0.5, cy: 0.5 },
  /** The grade panel's own corner, where the assistant's icon lives. */
  gradeCorner: { cx: 0.55, cy: 0.34 },
  composer: { cx: 0.5, cy: 0.78 },
  /** The assistant writes from the top of the pane down, so that is where to look. */
  transcript: { cx: 0.5, cy: 0.3 },
  table: { cx: 0.5, cy: 0.3 },
  compareTabs: { cx: 0.72, cy: 0.17 },
} as const;

/**
 * Phone takes, filmed at 430x932. Each surface has its own layout, so each gets its own
 * points; the values are read straight off the captured frames.
 */
const LOGIN_AT = {
  logo: { cx: 0.5, cy: 0.3 },
  email: { cx: 0.5, cy: 0.524 },
  code: { cx: 0.5, cy: 0.685 },
  submit: { cx: 0.5, cy: 0.787 },
  centre: { cx: 0.5, cy: 0.5 },
} as const;

const DAY_AT = {
  top: { cx: 0.5, cy: 0.28 },
  centre: { cx: 0.5, cy: 0.5 },
  lower: { cx: 0.5, cy: 0.72 },
} as const;

/**
 * The customer's screen.
 *
 * The free-text field sits in the bottom seventh of the phone, so the camera looks at
 * the bottom of it: a shot centred on the middle of this screen is a shot of the empty
 * space above the only thing happening.
 */
const CLIENT_AT = {
  story: { cx: 0.5, cy: 0.78 },
  storyClose: { cx: 0.5, cy: 0.82 },
  form: { cx: 0.5, cy: 0.62 },
  send: { cx: 0.5, cy: 0.88 },
  centre: { cx: 0.5, cy: 0.5 },
} as const;

const key = (at: number, scale: number, point: { cx: number; cy: number }): CameraKey => ({
  at,
  scale,
  cx: point.cx,
  cy: point.cy,
});

const SHOT = {
  intro: sec(3.7),
  welcome: sec(2.7),
  /** The board and the map are one move, not two shots. */
  board: sec(8.6),
  crew: sec(4.6),
  cardEngineer: sec(3.25),
  engineerLogin: sec(5.8),
  engineerOnLine: sec(2.8),
  engineerVisit: sec(4.9),
  engineerDay: sec(4.6),
  cardClient: sec(3.1),
  clientStory: sec(4.6),
  clientSend: sec(4.6),
  cardReplan: sec(2.8),
  /** Notice, press, and the panel it opens — one continuous move. */
  replan: sec(10.4),
  cardAi: sec(3.7),
  aiChat: sec(8.6),
  alertSolve: sec(5.4),
  cardControl: sec(2.7),
  /** Policy pill to metrics dialog to the assistant's reading — one continuous move. */
  control: sec(12.6),
  compare: sec(6.8),
  dayEnd: sec(9.4),
  outro: sec(8.6),
} as const;

const T = {
  soft: sec(0.3),
  hard: sec(0.22),
  whip: sec(0.26),
  flash: sec(0.2),
  /** The intro hands over to a screen that is already in the same place. */
  handoff: sec(0.55),
} as const;

/** The last frame of the day, in the day-end take's own time — where the desk picks up. */
const DAY_END_FROM = Math.max(0, mark('day-end', 'results', 0) - 1.2);
/**
 * Fast enough that the shot stops a couple of seconds short of the take.
 *
 * The desk picks the take up where this leaves it and keeps playing, so running the shot
 * all the way to the last frame would leave the desk with nothing to play.
 */
const DAY_END_RATE = fit(Math.max(3, tail('day-end', 'results', 14) - 1.3), 9.4);
const DESK_CONTINUES_AT = DAY_END_FROM + (SHOT.dayEnd / 60) * DAY_END_RATE;

export function Reel() {
  return (
    <AbsoluteFill style={{ backgroundColor: color.stage }}>
      <style>{FONT_FACES}</style>
      <Audio src={staticFile('audio/reel.m4a')} volume={0.82} />
      <TransitionSeries>
        {/* The logo lockup, built, then handed to the product's own start screen. The
            two sit in exactly the same place, so the cut is a dissolve rather than a move. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.intro}>
          <Intro />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.035 })}
          timing={linearTiming({ durationInFrames: T.handoff })}
        />

        {/* The shift is opened. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.welcome}>
          <Desk
            scene="open"
            from="welcome"
            camera={[
              key(0, 1.06, DESK_AT.lockup),
              key(0.9, 1.0, DESK_AT.centre),
              { ...key(2.0, 1.38, DESK_AT.startButton), ease: [0.66, 0, 0.2, 1] },
              key(2.7, 1.42, DESK_AT.startButton),
            ]}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={flash({ tint: color.bee })}
          timing={linearTiming({ durationInFrames: T.flash })}
        />

        {/* The whole board, and then the same board coming closer.
            One take, one camera: the map the reel pushes into is the map that was already
            on screen, and the chords turning into roads happen inside the push. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.board}>
          <Desk
            scene="open"
            from="dashboard"
            offset={-0.15}
            rate={fit(span('open', 'dashboard', 'roads', 11) + 2.4, 8.6)}
            camera={[
              key(0, 1.26, DESK_AT.centre),
              key(1.9, 1.0, DESK_AT.centre),
              key(2.9, 1.0, DESK_AT.centre),
              { ...key(5.9, 1.46, DESK_AT.map), ease: [0.5, 0, 0.18, 1] },
              key(8.6, 1.62, DESK_AT.mapTight),
            ]}
          >
            <Caption
              kicker="Карта"
              text="Прямая становится дорогой"
              at={sec(4.4)}
              hold={sec(2.6)}
            />
          </Desk>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'right' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        {/* The crew column, one engineer chosen — and straight back out to the board his
            name just rearranged: pipeline along the bottom, detail panel down the right. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.crew}>
          <Desk
            scene="engineers"
            from="hover"
            offset={-1.1}
            camera={[
              key(0, 1.5, DESK_AT.crewColumn),
              key(1.3, 1.56, DESK_AT.crewColumn),
              { ...key(2.6, 1.0, DESK_AT.centre), ease: [0.5, 0, 0.2, 1] },
              key(4.6, 1.03, DESK_AT.centre),
            ]}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'left' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        <TransitionSeries.Sequence durationInFrames={SHOT.cardEngineer}>
          <CardEngineer />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.2 })}
          timing={linearTiming({ durationInFrames: T.soft })}
        />

        {/* The address, the code from the letter, and the line. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.engineerLogin}>
          <Phone
            scene="engineer-login"
            backdrop="open"
            from="login"
            rate={fit(span('engineer-login', 'login', 'onShift', 16), 5.8)}
            height={872}
            y={492}
            camera={[
              key(0, 1.0, LOGIN_AT.centre),
              key(1.3, 1.1, LOGIN_AT.email),
              key(2.8, 1.34, LOGIN_AT.code),
              key(4.2, 1.12, LOGIN_AT.submit),
              key(5.8, 1.0, LOGIN_AT.centre),
            ]}
          />
        </TransitionSeries.Sequence>

        {/* No cut here: the same take, at its own speed, so the screen the press opens
            gets the beat it deserves instead of being rushed past. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.engineerOnLine}>
          <Phone
            scene="engineer-login"
            backdrop="open"
            from="onShift"
            height={872}
            y={492}
            camera={[key(0, 1.0, LOGIN_AT.centre), key(2.8, 1.06, DAY_AT.top)]}
          >
            <Caption
              kicker="Смена"
              text="Код из письма — и инженер на линии"
              at={sec(0.3)}
              hold={sec(1.7)}
              align="centre"
            />
          </Phone>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.12 })}
          timing={linearTiming({ durationInFrames: T.hard })}
        />

        {/* The visit is opened, taken and closed. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.engineerVisit}>
          <Phone
            scene="engineer-day"
            backdrop="open"
            from="day"
            rate={fit(span('engineer-day', 'day', 'inProgress', 11.5), 4.9)}
            height={872}
            y={492}
            camera={[
              key(0, 1.02, DAY_AT.centre),
              key(1.3, 1.1, DAY_AT.top),
              key(2.8, 1.06, DAY_AT.centre),
              key(4.9, 1.12, DAY_AT.lower),
            ]}
          >
            <Caption
              kicker="Визит"
              text="Паспорт объекта уже в карточке"
              at={sec(2.4)}
              hold={sec(1.7)}
              align="centre"
            />
          </Phone>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.1 })}
          timing={linearTiming({ durationInFrames: T.hard })}
        />

        {/* Back to the list, and down through the rest of the day — lunch included. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.engineerDay}>
          <Phone
            scene="engineer-day"
            backdrop="open"
            from="backToList"
            offset={-0.3}
            rate={fit(span('engineer-day', 'backToList', 'scrollEnd', 14.6), 4.6)}
            height={872}
            y={492}
            camera={[
              key(0, 1.06, DAY_AT.top),
              key(1.8, 1.0, DAY_AT.centre),
              key(4.6, 1.02, DAY_AT.centre),
            ]}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'up' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        <TransitionSeries.Sequence durationInFrames={SHOT.cardClient}>
          <CardClient />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.2 })}
          timing={linearTiming({ durationInFrames: T.soft })}
        />

        {/* Free text in. The camera sits on the bottom of the phone, where the field is. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.clientStory}>
          <Phone
            scene="client"
            backdrop="open"
            from="autoTab"
            offset={-0.4}
            rate={fit(span('client', 'autoTab', 'formFilled', 17.6), 4.6)}
            height={872}
            y={492}
            camera={[
              key(0, 1.0, CLIENT_AT.story),
              key(1.5, 1.1, CLIENT_AT.storyClose),
              key(4.6, 1.14, CLIENT_AT.storyClose),
            ]}
          >
            <Caption
              kicker="Авария"
              text="Рассказ клиента становится заявкой"
              at={sec(0.2)}
              hold={sec(2.0)}
              align="centre"
            />
          </Phone>
        </TransitionSeries.Sequence>

        {/* No cut: the form has just replaced the story on the same screen, and the shot
            answers by closing in while the phone rides up. A transition here is the flash. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.clientSend}>
          <Phone
            scene="client"
            backdrop="open"
            from="formFilled"
            rate={fit(span('client', 'formFilled', 'submit', 12.3), 4.6)}
            height={872}
            y={492}
            camera={[
              key(0, 1.14, CLIENT_AT.storyClose),
              { ...key(1.6, 1.24, CLIENT_AT.form), ease: [0.5, 0, 0.2, 1] },
              key(3.2, 1.26, CLIENT_AT.send),
              key(4.6, 1.28, CLIENT_AT.send),
            ]}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'left' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        <TransitionSeries.Sequence durationInFrames={SHOT.cardReplan}>
          <CardReplan />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.18 })}
          timing={linearTiming({ durationInFrames: T.hard })}
        />

        {/* The board, the notice in the corner, the press on it, and the panel it opens —
            all on one take. The pull back out of the corner is what reveals the diff,
            because that is how the product does it. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.replan}>
          <Desk
            scene="replan"
            from="rebuilt"
            camera={[
              key(0, 1.0, DESK_AT.centre),
              { ...key(1.4, 1.46, DESK_AT.toastCorner), ease: [0.68, 0, 0.18, 1] },
              key(5.6, 1.5, DESK_AT.toastCorner),
              { ...key(7.2, 1.06, DESK_AT.centre), ease: [0.55, 0, 0.2, 1] },
              key(8.8, 1.2, DESK_AT.centre),
              key(10.4, 1.08, DESK_AT.centre),
            ]}
          >
            <Caption
              kicker="Переплан"
              text="Видно, что именно изменилось"
              at={sec(7.4)}
              hold={sec(2.0)}
            />
          </Desk>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.24 })}
          timing={linearTiming({ durationInFrames: T.soft })}
        />

        <TransitionSeries.Sequence durationInFrames={SHOT.cardAi}>
          <CardAi />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={flash({ tint: color.white })}
          timing={linearTiming({ durationInFrames: T.flash })}
        />

        {/* Straight onto the assistant's own page: the question typed into it, sent, and
            the answer already being written back. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.aiChat}>
          <Desk
            scene="ai-chat"
            from="chat"
            rate={fit(span('ai-chat', 'chat', 'streamMid', 11.5), 8.6)}
            camera={[
              key(0, 1.0, DESK_AT.centre),
              { ...key(1.8, 1.3, DESK_AT.composer), ease: [0.6, 0, 0.2, 1] },
              key(4.4, 1.34, DESK_AT.composer),
              { ...key(6.0, 1.12, DESK_AT.transcript), ease: [0.5, 0, 0.2, 1] },
              key(8.6, 1.06, DESK_AT.transcript),
            ]}
          >
            <Caption
              kicker="System One"
              text="Ответ по фактам сегодняшнего плана"
              at={sec(6.0)}
              hold={sec(2.2)}
            />
          </Desk>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'down' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        {/* An alert solved by the assistant: the press, the ring around the option it
            picked, and the card leaving the board. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.alertSolve}>
          <Desk
            scene="alert-solve"
            from="alerts"
            rate={fit(span('alert-solve', 'alerts', 'alertGone', 8), 5.4)}
            camera={[
              key(0, 1.0, DESK_AT.centre),
              key(1.4, 1.3, DESK_AT.alertCard),
              key(3.0, 1.34, DESK_AT.alertCard),
              { ...key(4.2, 1.14, DESK_AT.alertCard), ease: [0.5, 0, 0.2, 1] },
              key(5.4, 1.02, DESK_AT.centre),
            ]}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.2 })}
          timing={linearTiming({ durationInFrames: T.soft })}
        />

        <TransitionSeries.Sequence durationInFrames={SHOT.cardControl}>
          <CardControl />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.18 })}
          timing={linearTiming({ durationInFrames: T.hard })}
        />

        {/* The header, walked end to end without a cut: the policy panel opens, the
            cursor carries on left to the metrics dialog, the plan is optimised, and the
            assistant takes over the explanation of its own grade. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.control}>
          <Desk
            scene="policy-metrics"
            from="overview"
            rate={fit(span('policy-metrics', 'overview', 'comparePressed', 30), 12.6)}
            camera={[
              key(0, 1.0, DESK_AT.centre),
              { ...key(1.6, 1.44, DESK_AT.header), ease: [0.62, 0, 0.18, 1] },
              key(3.3, 1.2, DESK_AT.policyPanel),
              key(5.0, 1.16, DESK_AT.metricsButton),
              { ...key(6.6, 1.24, DESK_AT.modal), ease: [0.5, 0, 0.2, 1] },
              key(9.2, 1.32, DESK_AT.modal),
              key(10.4, 1.4, DESK_AT.gradeCorner),
              key(12.6, 1.18, DESK_AT.modal),
            ]}
          >
            <Caption
              kicker="Надёжность"
              text="День прожит 300 раз до того, как начался"
              at={sec(6.6)}
              hold={sec(2.8)}
            />
          </Desk>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={whip({ direction: 'left' })}
          timing={linearTiming({ durationInFrames: T.whip })}
        />

        {/* The same question asked of every strategy at once, in numbers and then on the
            map, where each policy draws its own day in its own colour. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.compare}>
          <Desk
            scene="policy-compare"
            from="overview"
            rate={fit(span('policy-compare', 'overview', 'mapReady', 18), 6.8)}
            camera={[
              key(0, 1.02, DESK_AT.centre),
              key(1.1, 1.18, DESK_AT.table),
              key(1.9, 1.16, DESK_AT.compareTabs),
              { ...key(3.2, 1.06, DESK_AT.centre), ease: [0.5, 0, 0.2, 1] },
              key(6.8, 1.2, DESK_AT.map),
            ]}
          >
            <Caption
              kicker="Политики"
              text="Один день, семь стратегий, один набор фактов"
              at={sec(0.4)}
              hold={sec(2.4)}
            />
          </Desk>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={pushThrough({ depth: 0.14 })}
          timing={linearTiming({ durationInFrames: T.soft })}
        />

        {/* The shift is closed, the result is read, and the panel is closed again — so the
            reel ends the day on the board, which is what the desk shot pulls away from. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.dayEnd}>
          <Desk
            scene="day-end"
            from={DAY_END_FROM}
            rate={DAY_END_RATE}
            camera={[
              key(0, 1.14, DESK_AT.centre),
              key(2.6, 1.0, DESK_AT.centre),
              key(9.4, 1.0, DESK_AT.centre),
            ]}
          />
        </TransitionSeries.Sequence>

        {/* No cut, no transition. The frame that was the whole screen a moment ago keeps
            playing while the camera pulls away from it, and what it was playing on turns
            out to have been a laptop all along. */}
        <TransitionSeries.Sequence durationInFrames={SHOT.outro}>
          <Outro deskScene="day-end" deskFrom={DESK_CONTINUES_AT} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
}

/**
 * Frames the reel runs for.
 *
 * A Remotion transition is an overlap: it costs frames from both sides, so the reel is
 * the sum of its shots less the sum of its cuts. The list below is the cuts in the order
 * they appear above — keep the two in step when a shot is added or removed. Shots that
 * run into one another without a transition contribute nothing here, which is the point
 * of them.
 */
const CUTS = [
  T.handoff, // intro -> the start screen
  T.flash, // the shift opens
  T.whip, // the map -> the crew column
  T.whip, // the crew -> ИНЖЕНЕР
  T.soft, // ИНЖЕНЕР -> the login
  T.hard, // on the line -> the visit
  T.hard, // the visit -> the rest of the day
  T.whip, // the day -> КЛИЕНТ
  T.soft, // КЛИЕНТ -> the story
  T.whip, // the send -> ПЕРЕПЛАН
  T.hard, // ПЕРЕПЛАН -> the notice and the difference
  T.soft, // the difference -> AI
  T.flash, // AI -> the assistant's page
  T.whip, // the answer -> the alert solved
  T.soft, // solved -> КОНТРОЛЬ
  T.hard, // КОНТРОЛЬ -> the header
  T.whip, // the header -> the comparison
  T.soft, // the comparison -> the close of the day
] as const;

export const REEL_FRAMES =
  Object.values(SHOT).reduce((total, value) => total + value, 0) -
  CUTS.reduce((total, value) => total + value, 0);
