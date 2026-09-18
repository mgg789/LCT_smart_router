import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { FIGMA_ASSETS } from './assets';
import {
  FIGMA_ARTBOARD,
  MAIN_DASHBOARD,
  NAV_ITEMS,
  POLICY_OPTIONS,
  type EngineerCard,
  type NavItemId,
  type PolicyOption,
} from './fixtures';
import { FigmaIcon, FigmaText } from './primitives';

const NAV_ICONS = {
  navHome: FIGMA_ASSETS.navHome,
  navRequests: FIGMA_ASSETS.navRequests,
  navEngineers: FIGMA_ASSETS.navEngineers,
  navAlerts: FIGMA_ASSETS.navAlerts,
  navPolicy: FIGMA_ASSETS.navPolicy,
  navChats: FIGMA_ASSETS.navChats,
  navAi: FIGMA_ASSETS.navAi,
} as const;

const REASON_ICONS = {
  reasonCheck: { src: FIGMA_ASSETS.reasonCheck, width: 20, height: 13, top: 71, left: 16 },
  reasonCar: { src: FIGMA_ASSETS.reasonCar, width: 20, height: 20, top: 102, left: 16 },
  reasonClock: { src: FIGMA_ASSETS.reasonClock, width: 18, height: 20, top: 138, left: 17 },
  reasonPin: { src: FIGMA_ASSETS.reasonPin, width: 17, height: 18, top: 173, left: 18 },
} as const;

/**
 * Dispatcher MAIN screen from Figma 28:614 / 29:2552.
 * Static first pass: mock copy only, no dispatch API.
 */
export function MainDashboardPage() {
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy, setPolicy] = useState<PolicyOption>(MAIN_DASHBOARD.defaultPolicy);
  const [lunchOn, setLunchOn] = useState(true);
  const [activeNav, setActiveNav] = useState<NavItemId>('day');
  const [selectedEngineerId, setSelectedEngineerId] = useState(
    MAIN_DASHBOARD.engineers[0]?.id ?? 'sokolov',
  );

  useEffect(() => {
    if (!policyOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPolicyOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [policyOpen]);

  const scale = useArtboardScale();

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-figma-canvas">
      <div
        className="relative shrink-0 bg-figma-canvas"
        data-name="MAIN"
        style={{
          width: FIGMA_ARTBOARD.width,
          height: FIGMA_ARTBOARD.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <SidebarNav activeNav={activeNav} onSelect={setActiveNav} />
        <HeaderTools />
        <PolicyControl
          open={policyOpen}
          policy={policy}
          lunchOn={lunchOn}
          onToggle={() => setPolicyOpen((value) => !value)}
          onSelect={(next) => {
            setPolicy(next);
          }}
          onLunchToggle={() => setLunchOn((value) => !value)}
        />
        <FigmaText className="absolute left-[180px] top-[100px] font-murs text-[32px] tracking-[-0.544px] text-figma-ink">
          {MAIN_DASHBOARD.dateLabel}
        </FigmaText>
        <EngineersColumn
          selectedEngineerId={selectedEngineerId}
          onSelect={setSelectedEngineerId}
        />
        <MapCard />
        <RouteCard />
        <RequestCard />
        {policyOpen ? (
          <button
            type="button"
            aria-label="Закрыть список политик"
            className="absolute inset-0 z-10 cursor-default bg-transparent"
            onClick={() => setPolicyOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Fits the 1920×1080 mockup into the viewport without changing its internal layout.
 * At exactly 1920×1080 the scale is 1, so browser screenshots stay pixel-identical.
 */
function useArtboardScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      setScale(Math.min(window.innerWidth / FIGMA_ARTBOARD.width, window.innerHeight / FIGMA_ARTBOARD.height));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return scale;
}

function SidebarNav({
  activeNav,
  onSelect,
}: {
  activeNav: NavItemId;
  onSelect: (id: NavItemId) => void;
}) {
  return (
    <aside className="absolute left-0 top-0 z-20 h-[1080px] w-[150px] overflow-visible rounded-br-[20px] rounded-tr-[20px] border-r-[0.5px] border-solid border-[rgba(158,158,158,0.3)] bg-white">
      <div className="absolute left-[73.25px] top-[52px] -translate-x-1/2 -translate-y-1/2">
        <FigmaIcon src={FIGMA_ASSETS.logo} alt="Beeline" width={44} height={44} />
      </div>
      <nav className="absolute left-[21px] top-[110px] flex w-[109px] flex-col gap-[10px]">
        {NAV_ITEMS.map((item) => {
          const active = item.id === activeNav;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={`relative h-[74px] w-full overflow-visible rounded-[10px] ${
                active ? 'bg-figma-ink' : 'bg-white'
              }`}
            >
              <FigmaIcon
                src={NAV_ICONS[item.icon]}
                alt=""
                width={item.id === 'alerts' ? 26 : item.id === 'chats' ? 26 : item.id === 'requests' ? 24 : item.id === 'day' || item.id === 'policy' ? 22 : 24}
                height={item.id === 'requests' ? 18 : item.id === 'alerts' ? 26 : item.id === 'chats' ? 24 : item.id === 'day' || item.id === 'policy' ? 22 : 24}
                className={navIconClass(item.id)}
              />
              <FigmaText
                className={`absolute top-[46px] font-semibold text-[16px] tracking-[-0.272px] ${
                  active ? 'text-white' : 'text-figma-ink'
                } ${navLabelClass(item.id)}`}
              >
                {item.label}
              </FigmaText>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function navIconClass(id: NavItemId): string {
  switch (id) {
    case 'day':
      return 'absolute left-1/2 top-[12px] -translate-x-1/2';
    case 'requests':
      return 'absolute left-1/2 top-[14px] -translate-x-1/2';
    case 'engineers':
      return 'absolute left-1/2 top-[10px] -translate-x-1/2';
    case 'alerts':
      return 'absolute left-1/2 top-[8px] -translate-x-1/2';
    case 'policy':
      return 'absolute left-1/2 top-[12px] -translate-x-1/2';
    case 'chats':
      return 'absolute left-1/2 top-[10px] -translate-x-1/2';
    case 'ai':
      return 'absolute left-1/2 top-[10px] -translate-x-1/2';
  }
}

function navLabelClass(id: NavItemId): string {
  switch (id) {
    case 'day':
      return 'left-[19px]';
    case 'engineers':
      return 'left-[13px]';
    case 'policy':
      return 'left-[17px]';
    default:
      return 'left-1/2 -translate-x-1/2 text-center';
  }
}

function HeaderTools() {
  return (
    <div className="absolute left-[1677px] top-[32px] z-30 h-[40px] w-[213px]">
      <FigmaIcon
        src={FIGMA_ASSETS.searchHeader}
        alt="Поиск"
        width={30}
        height={30}
        className="absolute left-0 top-1/2 -translate-y-1/2"
      />
      <FigmaIcon
        src={FIGMA_ASSETS.bellHeader}
        alt="Уведомления"
        width={30}
        height={30}
        className="absolute left-[55px] top-[7px]"
      />
      <div className="absolute left-[72px] top-[3px] flex h-[18px] w-[26px] items-center justify-center overflow-clip rounded-[20px] bg-figma-ink px-[6px]">
        <FigmaText className="font-medium text-[16px] tracking-[-0.8px] text-figma-soft">
          {MAIN_DASHBOARD.notificationCount}
        </FigmaText>
      </div>
      <div className="absolute left-[123px] top-1/2 flex -translate-y-1/2 items-center gap-[20px]">
        <div className="relative size-[50px] overflow-clip rounded-[81px] bg-figma-ink">
          <img
            alt=""
            src={FIGMA_ASSETS.avatarUser}
            className="absolute left-0 top-[-2px] size-[52px] max-w-none object-cover"
          />
        </div>
        <FigmaIcon src={FIGMA_ASSETS.chevronDown} alt="" width={20} height={20} />
      </div>
    </div>
  );
}

function PolicyControl({
  open,
  policy,
  lunchOn,
  onToggle,
  onSelect,
  onLunchToggle,
}: {
  open: boolean;
  policy: PolicyOption;
  lunchOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyOption) => void;
  onLunchToggle: () => void;
}) {
  return (
    <div
      className={`absolute left-[1289px] top-[26px] z-40 w-[363px] overflow-hidden rounded-[27px] bg-white ${
        open ? 'h-[451px]' : 'h-[51px]'
      }`}
    >
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="open"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="relative h-[451px] w-[363px]"
          >
            <FigmaText className="absolute left-[16px] top-[19px] font-murs text-[20px] text-figma-ink">
              Выбери свою политику
            </FigmaText>
            <button type="button" onClick={onToggle} className="absolute right-[4px] top-[4px]">
              <FigmaIcon src={FIGMA_ASSETS.policyArrowOpen} alt="Свернуть" width={43} height={43} />
            </button>
            {POLICY_OPTIONS.map((option, index) => (
              <button
                key={option}
                type="button"
                onClick={() => onSelect(option)}
                className="absolute left-0 h-[32px] w-full"
                style={{ top: 65 + index * 44 }}
              >
                <FigmaIcon
                  src={option === policy ? FIGMA_ASSETS.radioFilled : FIGMA_ASSETS.radioEmpty}
                  alt=""
                  width={24}
                  height={24}
                  className="absolute left-[16px] top-0"
                />
                <FigmaText className="absolute left-[50px] top-[4px] font-medium text-[20px] text-figma-ink">
                  {option}
                </FigmaText>
              </button>
            ))}
            <button type="button" onClick={onLunchToggle} className="absolute left-[16px] top-[325px]">
              {lunchOn ? (
                <FigmaIcon src={FIGMA_ASSETS.toggleOn} alt="Обед включён" width={59} height={29} />
              ) : (
                <span className="relative block h-[29px] w-[59px] overflow-clip">
                  <span className="absolute inset-0 rounded-[14.5px] bg-figma-muted" />
                  <span className="absolute left-[3px] top-[3px] size-[23px] rounded-full bg-white" />
                </span>
              )}
            </button>
            <FigmaText className="absolute left-[85px] top-[332px] font-medium leading-none text-[20px] text-black">
              Обед включён
            </FigmaText>
            <button
              type="button"
              className="absolute left-[16px] top-[370px] flex h-[67px] w-[331px] items-center justify-center overflow-clip rounded-[20px] bg-figma-bee p-[20px]"
            >
              <span className="font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
                Ручное управление
              </span>
            </button>
          </motion.div>
        ) : (
          <button
            key="closed"
            type="button"
            onClick={onToggle}
            className="relative flex h-[51px] w-[363px] items-center px-[16px] py-[10px] text-left"
          >
            <FigmaText className="w-[280px] font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
              Политика: {policy}
            </FigmaText>
            <span className="absolute right-[4px] top-1/2 -translate-y-1/2">
              <FigmaIcon src={FIGMA_ASSETS.policyArrowClosed} alt="Открыть политики" width={43} height={43} />
            </span>
          </button>
        )}
      </AnimatePresence>
    </div>
  );
}

function EngineersColumn({
  selectedEngineerId,
  onSelect,
}: {
  selectedEngineerId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="absolute left-[180px] top-[154px] h-[893px] w-[411px] rounded-[20px] bg-white">
      <FigmaText className="absolute left-[30px] top-[30px] font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
        {MAIN_DASHBOARD.requestCountLabel}
      </FigmaText>
      <FigmaText className="absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {MAIN_DASHBOARD.planSummary}
      </FigmaText>
      <FigmaText className="absolute left-[30px] top-[121px] font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
        Инженеры
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.dotEngineers}
        alt=""
        width={5}
        height={5}
        className="absolute left-[166px] top-[128px]"
      />
      <FigmaText className="absolute left-[181px] top-[121px] font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
        {MAIN_DASHBOARD.engineerCount}
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.searchPanel}
        alt="Найти инженера"
        width={22}
        height={22}
        className="absolute left-[359px] top-[130px]"
      />
      {MAIN_DASHBOARD.engineers.map((engineer, index) => (
        <EngineerRow
          key={engineer.id}
          engineer={engineer}
          selected={engineer.id === selectedEngineerId}
          top={170 + index * 152}
          first={index === 0}
          onSelect={() => onSelect(engineer.id)}
        />
      ))}
      <div className="absolute left-[30px] top-[778px] w-[351px] overflow-clip rounded-[20px] bg-figma-bee px-[29px] py-[25px]">
        <div className="relative h-[46px]">
          <FigmaText className="font-murs text-[20px] tracking-[0.2px] text-figma-ink">
            {MAIN_DASHBOARD.unassigned.title}
          </FigmaText>
          <FigmaText className="absolute left-[6px] top-[30px] font-semibold text-[16px] tracking-[0.16px] text-figma-sub">
            {MAIN_DASHBOARD.unassigned.reason}
          </FigmaText>
        </div>
      </div>
    </section>
  );
}

function EngineerRow({
  engineer,
  selected,
  top,
  first,
  onSelect,
}: {
  engineer: EngineerCard;
  selected: boolean;
  top: number;
  first: boolean;
  onSelect: () => void;
}) {
  const nameLeft = first ? 68 : 69;
  const nameTop = first ? 22 : 23;
  const avatarTop = first ? 19 : 20;
  const kmLeft = first ? 288 : 289;
  const kmTop = first ? 24 : 25;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ top }}
      className={`absolute left-[30px] h-[132px] w-[351px] overflow-clip rounded-[15px] text-left ${
        selected ? 'border border-solid border-figma-muted' : ''
      }`}
    >
      <img
        alt=""
        src={FIGMA_ASSETS.avatarEngineer}
        className="absolute left-[15px] size-[44px] max-w-none object-cover"
        style={{ top: avatarTop }}
      />
      <FigmaText
        className="absolute font-murs text-[20px] tracking-[0.2px] text-black"
        style={{ left: nameLeft, top: nameTop }}
      >
        {engineer.name}
      </FigmaText>
      <FigmaText className="absolute left-[69px] top-[49px] font-medium text-[16px] tracking-[-0.272px] text-figma-muted">
        в работе
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.dotMeta}
        alt=""
        width={3}
        height={3}
        className="absolute left-[141px] top-[55px]"
      />
      <FigmaText className="absolute left-[149px] top-[49px] font-medium text-[16px] tracking-[-0.272px] text-figma-muted">
        6 заявок
      </FigmaText>
      <FigmaText
        className="absolute font-bold text-[16px] tracking-[0.16px] text-black"
        style={{ left: kmLeft, top: kmTop }}
      >
        28 км
      </FigmaText>
      <div className="absolute left-[15px] top-[81px] h-[8px] w-[321px] rounded-[13px] bg-figma-track" />
      <div
        className="absolute left-[15px] top-[81px] h-[8px] rounded-[13px] bg-figma-ink"
        style={{ width: engineer.progressPx }}
      />
      <FigmaText className="absolute left-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        8:00-17:00
      </FigmaText>
      <FigmaText className="absolute left-[220px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        выполнено 2/6
      </FigmaText>
    </button>
  );
}

function MapCard() {
  return (
    <section className="absolute left-[623px] top-[154px] h-[582px] w-[751px] overflow-clip rounded-[20px] bg-white">
      <div className="absolute left-1/2 top-[268px] h-[628px] w-[1227px] -translate-x-1/2 -translate-y-1/2">
        <img
          alt="Карта Москвы"
          src={FIGMA_ASSETS.map}
          className="absolute inset-0 size-full max-w-none object-cover"
        />
      </div>
    </section>
  );
}

function RouteCard() {
  return (
    <section className="absolute left-[623px] top-[768px] h-[279px] w-[751px] overflow-clip rounded-[20px] bg-white">
      <FigmaText className="absolute left-[30px] top-[30px] font-bold text-[28px] tracking-[-0.476px] text-figma-ink">
        {MAIN_DASHBOARD.route.title}
      </FigmaText>
      <FigmaText className="absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {MAIN_DASHBOARD.route.updated}
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.timeline}
        alt=""
        width={857}
        height={20}
        className="absolute left-[102px] top-[129px]"
      />
      <FigmaText className="absolute left-[88px] top-[165px] font-semibold text-[24px] tracking-[-0.408px] text-black">
        9:10
      </FigmaText>
      <FigmaText className="absolute left-[24px] top-[194px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        Офис - ул. Лесная, 7
      </FigmaText>
      <FigmaText className="absolute left-[69px] top-[223px] font-semibold text-[16px] tracking-[-0.272px] text-figma-hint">
        выполнено
      </FigmaText>
      <FigmaText className="absolute left-[391.5px] top-[165px] -translate-x-1/2 text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
        10:13
      </FigmaText>
      <FigmaText className="absolute left-[391px] top-[194px] -translate-x-1/2 text-center font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        Магазин - ул. Покровка, 11
      </FigmaText>
      <FigmaText className="absolute left-[348px] top-[223px] font-semibold text-[16px] tracking-[-0.272px] text-figma-hint">
        выполнено
      </FigmaText>
      <FigmaText className="absolute left-[670.5px] top-[165px] -translate-x-1/2 text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
        12:20
      </FigmaText>
      <FigmaText className="absolute left-[670.5px] top-[194px] w-[195px] -translate-x-1/2 text-center font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        Подключение офиса - Таганская, 24
      </FigmaText>
      <FigmaText className="absolute left-[584px] top-[245px] font-semibold text-[16px] tracking-[-0.272px] text-figma-hint">
        сейчас - визит 45 мин
      </FigmaText>
      <div className="absolute left-[174px] top-[267px] h-[6px] w-[321px] rounded-[13px] bg-figma-hint" />
    </section>
  );
}

function RequestCard() {
  const request = MAIN_DASHBOARD.request;
  return (
    <aside className="absolute left-[1406px] top-[154px] h-[893px] w-[484px] overflow-clip rounded-[20px] bg-figma-ink">
      <FigmaText className="absolute left-[30px] top-[30px] font-murs text-[32px] tracking-[-0.544px] text-white">
        {request.number}
      </FigmaText>
      <FigmaIcon
        src={FIGMA_ASSETS.statusDot}
        alt=""
        width={10}
        height={10}
        className="absolute left-[320px] top-[36px]"
      />
      <FigmaText className="absolute left-[30px] top-[74px] font-semibold text-[24px] tracking-[-0.408px] text-white/60">
        {request.title}
      </FigmaText>
      <div className="absolute left-[30px] top-[111px] flex items-center justify-center rounded-[20px] bg-figma-track px-[20px] py-[12px]">
        <FigmaText className="font-medium text-[20px] tracking-[-0.34px] text-figma-ink">
          {request.tags[0]}
        </FigmaText>
      </div>
      <div className="absolute left-[172px] top-[111px] flex items-center justify-center rounded-[20px] bg-figma-track px-[20px] py-[12px]">
        <FigmaText className="font-medium text-[20px] tracking-[-0.34px] text-figma-ink">
          {request.tags[1]}
        </FigmaText>
      </div>
      <div className="absolute left-[27px] top-[198px] flex w-[430px] flex-col items-start gap-[16px]">
        <div className="flex h-[67px] w-[430px] items-center overflow-clip rounded-[20px] bg-figma-dim px-[20px]">
          <FigmaText className="font-medium text-[20px] tracking-[-0.6px] text-white">
            {request.company}
          </FigmaText>
        </div>
        <div className="flex w-[430px] gap-[12.48px]">
          <div className="relative h-[67px] w-[208.76px] overflow-clip rounded-[20px] bg-figma-dim">
            <FigmaText className="absolute left-[20px] top-[24px] font-medium text-[20px] tracking-[-0.6px] text-white">
              {request.address}
            </FigmaText>
          </div>
          <div className="flex h-[67px] w-[208.76px] items-center overflow-clip rounded-[20px] bg-figma-dim p-[20px]">
            <FigmaText className="font-medium text-[20px] tracking-[-0.6px] text-white">
              {request.window}
            </FigmaText>
          </div>
        </div>
        <div className="flex h-[67px] w-[430px] items-center overflow-clip rounded-[20px] bg-figma-dim p-[20px]">
          <FigmaText className="font-medium text-[20px] tracking-[-0.6px] text-white">
            {request.work}
          </FigmaText>
        </div>
        <div className="relative h-[216px] w-[430px] overflow-clip rounded-[20px] bg-figma-dim">
          <FigmaText className="absolute left-[20px] top-[26px] font-medium text-[28px] tracking-[-0.84px] text-white">
            {request.whyTitle}
          </FigmaText>
          {request.reasons.map((reason, index) => {
            const icon = REASON_ICONS[reason.icon];
            return (
              <div key={reason.label}>
                <FigmaIcon
                  src={icon.src}
                  alt=""
                  width={icon.width}
                  height={icon.height}
                  className="absolute"
                  style={{ left: icon.left, top: icon.top }}
                />
                <FigmaText
                  className="absolute left-[46px] font-medium text-[20px] tracking-[-0.6px] text-white/60"
                  style={{ top: 70 + index * 35 }}
                >
                  {reason.label}
                </FigmaText>
              </div>
            );
          })}
        </div>
      </div>
      <button
        type="button"
        className="absolute left-[27px] top-[711px] flex h-[67px] w-[430px] items-center justify-center overflow-clip rounded-[20px] bg-figma-bee p-[20px]"
      >
        <span className="font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
          Сменить пользователя
        </span>
      </button>
      <button
        type="button"
        className="absolute left-[27px] top-[794px] flex h-[67px] w-[430px] items-center justify-center overflow-clip rounded-[20px] border border-solid border-white bg-figma-ink px-[131px] py-[23px]"
      >
        <span className="font-semibold text-[20px] tracking-[-0.6px] text-white">
          Разобрать с AI ассистентом
        </span>
      </button>
    </aside>
  );
}
