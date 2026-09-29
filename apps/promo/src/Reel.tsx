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
import { Arrow, Loop, Note, type Point, useDeskMap, usePhoneMap } from './components/Sketch.tsx';
import { WordCard } from './components/Type.tsx';
import { flash, pushThrough, whip } from './components/transitions.tsx';
import { hasMark, hasShot, mark } from './footage.ts';
import { Intro } from './scenes/Intro.tsx';
import { Outro } from './scenes/Outro.tsx';
import { color, FONT_FACES, MARKER_BLUE } from './theme.ts';

const sec = (value: number) => Math.round(value * 60);

/** Seconds between two marks on the same take, with a floor so a shot is never empty. */
function span(scene: string, from: string, to: string, fallback: number): number {
  if (!hasShot(scene)) return fallback;
  const length = mark(scene, to, 0) - mark(scene, from, 0);
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

// --- the marker ----------------------------------------------------------------
//
// Circles and notes are placed in the take's own coordinates and ride the same camera
// as the shot, so they stay on what they name while the frame moves.

type ToScreen = (x: number, y: number) => Point;

/** A box in take coordinates: centre and size, all 0..1. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function OnDesk({
  scene,
  camera,
  children,
}: {
  scene: string;
  camera: readonly CameraKey[];
  children: (to: ToScreen) => ReactNode;
}) {
  const to = useDeskMap(scene, camera);
  return <>{children(to)}</>;
}

function OnPhone({
  scene,
  camera,
  children,
}: {
  scene: string;
  camera: readonly CameraKey[];
  children: (to: ToScreen) => ReactNode;
}) {
  const to = usePhoneMap(scene, camera, PHONE);
  return <>{children(to)}</>;
}

/** A loop around a box, padded so the pen clears what it circles. */
function Ring({
  to,
  box,
  at,
  hold,
  seed,
  color,
}: {
  to: ToScreen;
  box: Box;
  at: number;
  hold: number;
  seed: number;
  color?: string;
}) {
  const centre = to(box.x, box.y);
  const rx = (to(box.x + box.w / 2, box.y).x - to(box.x - box.w / 2, box.y).x) / 2;
  const ry = (to(box.x, box.y + box.h / 2).y - to(box.x, box.y - box.h / 2).y) / 2;
  return (
    <Loop
      centre={centre}
      rx={rx * 1.12 + 14}
      ry={ry * 1.3 + 12}
      at={at}
      hold={hold}
      seed={seed}
      color={color}
    />
  );
}

/** Every phone shot sits at the same place on the stage. */
const PHONE = { height: 860, y: 540 } as const;

/** The passport, framed so the whole phone stays in view and nothing is pressed on it. */
function EngineerPassport() {
  if (hasMark('engineer-login', 'passport')) {
    const rate = fit(span('engineer-login', 'dayList', 'passport', 5), 2.4);
    const camera = [key(0, 1, DAY_AT.centre), key(5.4, 1, DAY_AT.centre)];
    const passportAt = sec(2.5);
    return (
      <Phone
        scene="engineer-login"
        backdrop="open"
        from="dayList"
        rate={rate}
        height={PHONE.height}
        y={PHONE.y}
        camera={camera}
      >
        <Caption
          kicker="Визит"
          text="Паспорт объекта уже в карточке"
          at={sec(1.2)}
          hold={sec(3.8)}
          align="centre"
        />
        <OnPhone scene="engineer-login" camera={camera}>
          {(to) => (
            <>
              <Ring
                to={to}
                box={{ x: 0.5, y: 0.69, w: 0.92, h: 0.24 }}
                at={passportAt}
                hold={sec(3)}
                seed={11}
                color={MARKER_BLUE}
              />
              <Arrow
                from={{ x: to(1, 0.6).x + 70, y: to(1, 0.6).y - 6 }}
                to={{ x: to(1, 0.66).x + 14, y: to(1, 0.66).y }}
                bend={0.3}
                at={passportAt + 12}
                draw={12}
                hold={sec(2.6)}
                color={MARKER_BLUE}
              />
              <Note
                at={passportAt + 16}
                hold={sec(2.6)}
                position={{ x: to(1, 0.6).x + 80, y: to(1, 0.6).y - 30 }}
                color={MARKER_BLUE}
              >
                оптика, сложность 2 из 3
              </Note>
            </>
          )}
        </OnPhone>
      </Phone>
    );
  }
  const until = Math.max(
    1.2,
    mark('engineer-day', 'started', 8) - mark('engineer-day', 'day', 0) - 0.45,
  );
  return (
    <Phone
      scene="engineer-day"
      backdrop="open"
      from="day"
      rate={fit(until, 4.4)}
      height={860}
      y={540}
      camera={[key(0, 1, DAY_AT.centre), key(4.4, 1.02, DAY_AT.centre)]}
    >
      <Caption
        kicker="Визит"
        text="Паспорт объекта уже в карточке"
        at={sec(1.6)}
        hold={sec(1.8)}
        align="centre"
      />
    </Phone>
  );
}

const SHOT = {
  intro: sec(2.8),
  welcome: sec(2.4),
  /** Points, then the chords, then the roads — one move onto the map. */
  board: sec(7.4),
  crew: sec(3.8),
  /** Cards carry a moving diagram now, so each gets the time to finish drawing it. */
  cardEngineer: sec(3.8),
  engineerLogin: sec(5.2),
  engineerOnLine: sec(2.6),
  /** The day list and the passport, without a second screen in between. */
  engineerVisit: sec(5.4),
  cardClient: sec(3.8),
  clientStory: sec(4.4),
  clientSend: sec(3.8),
  cardReplan: sec(3.6),
  /** The routes actually change. The camera stays on the map while they do. */
  replan: sec(7.2),
  cardAi: sec(3.7),
  aiChat: sec(7.2),
  alertSolve: sec(4.6),
  cardControl: sec(3.6),
  control: sec(9.2),
  compare: sec(5.8),
  dayEnd: sec(3.4),
  outro: sec(6.8),
} as const;

const T = {
  soft: sec(0.3),
  hard: sec(0.22),
  whip: sec(0.26),
  flash: sec(0.2),
  /** The intro hands over to a screen that is already in the same place. */
  handoff: sec(0.55),
} as const;

/** The results panel is on screen only long enough to read, then it closes. */
const DAY_END_FROM = mark('day-end', 'results', 0);
const DAY_END_CLOSE = hasMark('day-end', 'resultsClosed')
  ? mark('day-end', 'resultsClosed')
  : DAY_END_FROM + 8;
const DAY_END_RATE = fit(Math.max(2.2, DAY_END_CLOSE - DAY_END_FROM), 3.4);
/** The desk shot begins on the press that closes the panel, not after a hold. */
const DESK_CONTINUES_AT = DAY_END_CLOSE;

/**
 * The rebuild as the map draws it: the old roads held, the new plan's chords, then the
 * new roads in waves (`capture/lib/mapStage.ts`). Older takes without that beat fall
 * back to the stretch after the policy change.
 */
const REPLAN_MORPH = hasMark('replan', 'morph');
const REPLAN_FROM = REPLAN_MORPH
  ? Math.max(0, mark('replan', 'morphFrom') - 1.2)
  : hasMark('replan', 'policyPicked')
    ? mark('replan', 'policyPicked') + 0.6
    : mark('replan', 'rebuilt', 0);
const REPLAN_UNTIL = REPLAN_MORPH
  ? mark('replan', 'morphDone') + 1.8
  : Math.max(REPLAN_FROM + 3, mark('replan', 'rebuilt', REPLAN_FROM + 8));
const REPLAN_RATE = fit(REPLAN_UNTIL - REPLAN_FROM, 7.2);
/** Seconds into the replan shot at which the new plan's chords replace the old roads. */
const REPLAN_CHORDS = REPLAN_MORPH ? (mark('replan', 'morph') - REPLAN_FROM) / REPLAN_RATE : 4.6;
const REPLAN_CAMERA = [
  key(0, 1.1, DESK_AT.map),
  key(7.2, 1.2, DESK_AT.map),
];

/** The login take plays fast; the camera lets go of the code field the moment it is full. */
const LOGIN_RATE = fit(span('engineer-login', 'login', 'onShift', 16), 5.2);
const LOGIN_CODE_DONE = (mark('engineer-login', 'codeTyped', 7.1) - mark('engineer-login', 'login', 0)) / LOGIN_RATE;

/** The board's map shot: where the walking engineer's metro leg is drawn. */
const BOARD_RATE = fit(span('open', 'points', hasMark('open', 'toastGone') ? 'toastGone' : 'roads', 9), 7.4);
const BOARD_METRO_AT = (mark('open', 'roads2', 30.3) - mark('open', 'points', 28)) / BOARD_RATE;
const BOARD_CAMERA = [
  key(0, 1.02, DESK_AT.centre),
  { ...key(0.9, 1.34, DESK_AT.map), ease: [0.5, 0, 0.18, 1] as const },
  key(2.4, 1.48, DESK_AT.map),
  key(7.4, 1.56, DESK_AT.mapTight),
];

const ALERT_RATE = fit(span('alert-solve', 'alerts', 'alertGone', 8), 4.6);
const ALERT_RING_AT = (mark('alert-solve', 'aiRing', 3.9) - mark('alert-solve', 'alerts', 0)) / ALERT_RATE;
const ALERT_CAMERA = [
  key(0, 1.0, DESK_AT.centre),
  key(1.1, 1.22, DESK_AT.alertCard),
  key(2.6, 1.26, DESK_AT.alertCard),
  key(3.6, 1.08, DESK_AT.centre),
  key(4.6, 1.0, DESK_AT.centre),
];

const COMPARE_CAMERA = [
  key(0, 1.02, DESK_AT.centre),
  key(1.2, 1.08, DESK_AT.map),
  { ...key(2.6, 1.16, DESK_AT.map), ease: [0.5, 0, 0.2, 1] as const },
  key(5.8, 1.2, DESK_AT.map),
];

const CLIENT_SEND_RATE = fit(span('client', 'formFilled', 'submit', 12.3), 3.8);
const clientSendAt = (name: string, fallback: number) =>
  hasMark('client', name)
    ? (mark('client', name) - mark('client', 'formFilled')) / CLIENT_SEND_RATE
    : fallback;
const CLIENT_SEND_CAMERA = [key(0, 1.0, CLIENT_AT.centre), key(3.8, 1.0, CLIENT_AT.centre)];

/** Music level per frame: flat, then eased to silence over the reel's last seconds. */
const MUSIC_FADE = sec(3.2);
function musicVolume(frame: number): number {
  const left = Math.min(1, Math.max(0, (REEL_FRAMES - frame) / MUSIC_FADE));
  return 0.82 * left * left;
}

export function Reel() {
  return (
    <AbsoluteFill style={{ backgroundColor: color.stage }}>
      <style>{FONT_FACES}</style>
      <Audio src={staticFile('audio/reel.m4a')} volume={musicVolume} />
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
              key(0.7, 1.0, DESK_AT.centre),
              { ...key(1.7, 1.32, DESK_AT.startButton), ease: [0.66, 0, 0.2, 1] },
              key(2.4, 1.36, DESK_AT.startButton),
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
            from="points"
            rate={BOARD_RATE}
            camera={BOARD_CAMERA}
          >
            <Caption
              kicker="Карта"
              text="Прямая становится дорогой"
              at={sec(1.5)}
              hold={sec(2.4)}
            />
            <OnDesk scene="open" camera={BOARD_CAMERA}>
              {(to) => (
                <>
                  <Arrow
                    from={to(0.525, 0.675)}
                    to={to(0.456, 0.625)}
                    bend={-0.25}
                    at={sec(BOARD_METRO_AT + 0.4)}
                    draw={14}
                    hold={sec(2.6)}
                  />
                  <Note
                    at={sec(BOARD_METRO_AT + 0.5)}
                    hold={sec(2.4)}
                    position={to(0.532, 0.69)}
                    size={52}
                  >
                    пешком + метро
                  </Note>
                </>
              )}
            </OnDesk>
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
              key(0, 1.42, DESK_AT.crewColumn),
              key(1.1, 1.46, DESK_AT.crewColumn),
              { ...key(2.2, 1.0, DESK_AT.centre), ease: [0.5, 0, 0.2, 1] },
              key(3.8, 1.02, DESK_AT.centre),
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
            rate={LOGIN_RATE}
            height={PHONE.height}
            y={PHONE.y}
            camera={[
              key(0, 1.0, LOGIN_AT.centre),
              key(Math.min(1.2, LOGIN_CODE_DONE - 1.4), 1.08, LOGIN_AT.email),
              key(LOGIN_CODE_DONE - 0.5, 1.16, LOGIN_AT.code),
              key(LOGIN_CODE_DONE, 1.16, LOGIN_AT.code),
              { ...key(LOGIN_CODE_DONE + 0.55, 1.0, LOGIN_AT.centre), ease: [0.5, 0, 0.2, 1] },
              key(5.2, 1.0, LOGIN_AT.centre),
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
            height={860}
            y={540}
            camera={[key(0, 1.0, LOGIN_AT.centre), key(2.6, 1.0, DAY_AT.centre)]}
          >
            <Caption
              kicker="Смена"
              text="Один клик — и он на линии"
              at={sec(0.3)}
              hold={sec(1.7)}
              align="centre"
            />
          </Phone>
        </TransitionSeries.Sequence>

        {/* The list the engineer just landed on, then the top card, then the passport.
            Same framing the whole way: the phone stays put, and nothing is pressed on
            the passport itself. When the capture opened the card inside the login take,
            this is that take continued; otherwise it is the day take, cut off before
            «Приступить». */}
        <TransitionSeries.Sequence durationInFrames={SHOT.engineerVisit}>
          <EngineerPassport />
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
            rate={fit(span('client', 'autoTab', 'formFilled', 17.6), 4.4)}
            height={860}
            y={540}
            camera={[
              key(0, 1.08, CLIENT_AT.story),
              key(2.2, 1.12, CLIENT_AT.storyClose),
              { ...key(3.3, 1.0, CLIENT_AT.centre), ease: [0.45, 0, 0.2, 1] },
              key(4.4, 1.0, CLIENT_AT.centre),
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
            rate={CLIENT_SEND_RATE}
            height={PHONE.height}
            y={PHONE.y}
            camera={CLIENT_SEND_CAMERA}
          >
            <OnPhone scene="client" camera={CLIENT_SEND_CAMERA}>
              {(to) => {
                const typed = sec(clientSendAt('addressTyped', 0.6));
                const picked = sec(clientSendAt('addressPicked', 2.2));
                return (
                  <>
                    <Ring
                      to={to}
                      box={{ x: 0.5, y: 0.509, w: 0.79, h: 0.054 }}
                      at={typed}
                      hold={Math.max(30, picked - typed + 40)}
                      seed={13}
                    />
                    <Arrow
                      from={{ x: to(1, 0.6).x + 48, y: to(1, 0.6).y + 8 }}
                      to={to(0.9, 0.62)}
                      bend={-0.25}
                      at={picked}
                      draw={12}
                      hold={52}
                      color={MARKER_BLUE}
                    />
                    <Note
                      at={picked + 4}
                      hold={48}
                      position={{ x: to(1, 0.6).x + 56, y: to(1, 0.6).y - 8 }}
                      color={MARKER_BLUE}
                    >
                      точка на карте
                    </Note>
                  </>
                );
              }}
            </OnPhone>
          </Phone>
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
            from={REPLAN_FROM}
            rate={REPLAN_RATE}
            camera={REPLAN_CAMERA}
          >
            <Caption
              kicker="Переплан"
              text="Маршруты на карте собрались заново"
              at={sec(REPLAN_CHORDS + 0.3)}
              hold={sec(2.4)}
            />
            {/* Pinned to the frame rather than the map: the camera barely moves here, and
                a note riding it drifts through the pixel grid. */}
            <Note at={sec(0.4)} hold={sec(Math.max(0.6, REPLAN_CHORDS - 1.1))} position={{ x: 700, y: 150 }} size={60}>
              было
            </Note>
            <Note
              at={sec(REPLAN_CHORDS + 0.1)}
              hold={sec(4)}
              position={{ x: 700, y: 150 }}
              size={60}
              color={MARKER_BLUE}
            >
              стало: новый план
            </Note>
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
            rate={fit(span('ai-chat', 'chat', 'streamMid', 11.5), 7.2)}
            camera={[
              key(0, 1.0, DESK_AT.centre),
              key(1.6, 1.06, DESK_AT.composer),
              { ...key(3.4, 1.02, DESK_AT.transcript), ease: [0.5, 0, 0.2, 1] },
              key(7.2, 1.0, DESK_AT.transcript),
            ]}
          >
            <Caption
              kicker="System One"
              text="Ответ по фактам сегодняшнего плана"
              at={sec(3.6)}
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
            rate={ALERT_RATE}
            camera={ALERT_CAMERA}
          >
            <OnDesk scene="alert-solve" camera={ALERT_CAMERA}>
              {(to) => (
                <>
                  <Ring
                    to={to}
                    box={{ x: 0.319, y: 0.42, w: 0.131, h: 0.058 }}
                    at={sec(ALERT_RING_AT) - 4}
                    hold={sec(1.1)}
                    seed={17}
                  />
                  <Arrow
                    from={to(0.525, 0.33)}
                    to={to(0.39, 0.395)}
                    bend={-0.2}
                    at={sec(ALERT_RING_AT) + 6}
                    draw={12}
                    hold={sec(1)}
                  />
                  <Note at={sec(ALERT_RING_AT) + 8} hold={sec(1)} position={to(0.535, 0.315)} size={50}>
                    System one выбрал
                  </Note>
                </>
              )}
            </OnDesk>
          </Desk>
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
            rate={fit(span('policy-metrics', 'overview', 'comparePressed', 30), 9.2)}
            camera={[
              key(0, 1.0, DESK_AT.centre),
              { ...key(1.5, 1.08, { cx: 0.62, cy: 0.28 }), ease: [0.55, 0, 0.2, 1] },
              key(3.0, 1.06, DESK_AT.policyPanel),
              key(4.6, 1.04, { cx: 0.55, cy: 0.24 }),
              { ...key(6.0, 1.1, DESK_AT.modal), ease: [0.5, 0, 0.2, 1] },
              key(8.0, 1.12, DESK_AT.gradeCorner),
              key(9.2, 1.04, DESK_AT.modal),
            ]}
          >
            <Caption
              kicker="Надёжность"
              text="День прожит 300 раз до того, как начался"
              at={sec(5.4)}
              hold={sec(2.2)}
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
            from="mapTab"
            offset={-0.3}
            rate={fit(span('policy-compare', 'mapTab', 'mapReady', 12), 5.8)}
            camera={COMPARE_CAMERA}
          >
            <Caption
              kicker="Политики"
              text="Один день, семь стратегий, один набор фактов"
              at={sec(0.4)}
              hold={sec(2.4)}
            />
            <OnDesk scene="policy-compare" camera={COMPARE_CAMERA}>
              {(to) => (
                <>
                  <Ring
                    to={to}
                    box={{ x: 0.9, y: 0.47, w: 0.11, h: 0.24 }}
                    at={sec(3.1)}
                    hold={sec(1.9)}
                    seed={19}
                    color={MARKER_BLUE}
                  />
                  <Note
                    at={sec(3.5)}
                    hold={sec(1.5)}
                    position={to(0.955, 0.735)}
                    size={50}
                    rotate={-5}
                    align="right"
                    color={MARKER_BLUE}
                  >
                    7 политик — 7 цветов
                  </Note>
                </>
              )}
            </OnDesk>
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
              key(0, 1.04, DESK_AT.centre),
              key(1.4, 1.0, DESK_AT.centre),
              key(3.4, 1.0, DESK_AT.centre),
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
  T.whip, // the passport -> КЛИЕНТ
  T.soft, // КЛИЕНТ -> the story
  T.whip, // the send -> ПЕРЕПЛАН
  T.hard, // ПЕРЕПЛАН -> the map
  T.soft, // the map -> AI
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
