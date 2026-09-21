import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { engineerHeaderStamp } from '../figma-engineer/engineerClock';
import { eu } from '../figma-engineer/engineerScale';
import { CLIENT_ASSETS } from './assets';
import { ClientMenu } from './ClientMenu';
import { ClientNewRequest } from './ClientNewRequest';
import { ClientRequestDetail } from './ClientRequestDetail';
import { ClientRequests } from './ClientRequests';
import {
  canSubmitClientForm,
  CLIENT_DETAIL_NOW_MS,
  CLIENT_LIST_NOW_MS,
  CLIENT_PREVIEW_REQUESTS,
  CLIENT_PROFILE,
  type ClientRequestDraft,
  type ClientRequestView,
  type ClientScreenId,
  EMPTY_CLIENT_DRAFT,
  nextClientRequestNumber,
  requestFromDraft,
} from './clientPreview';

const slideEase = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease: slideEase };

/**
 * Client App shell: FIRST 115:344 home, MAIN 115:204 list, REQUEST 115:713
 * overlay, MENU 115:843 drawer. First pass is local preview only.
 */
export function ClientApp() {
  const motionOn = !useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<ClientScreenId>('new');
  const [draft, setDraft] = useState<ClientRequestDraft>(EMPTY_CLIENT_DRAFT);
  const [requests, setRequests] = useState<ClientRequestView[]>(CLIENT_PREVIEW_REQUESTS);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opened = requests.find((item) => item.id === openedId) ?? null;
  const overlayOpen = opened !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const go = (next: ClientScreenId) => {
    setOpenedId(null);
    setScreen(next);
    setMenuOpen(false);
    setNotice(null);
  };

  const submit = () => {
    if (!canSubmitClientForm(draft)) {
      setNotice('Заполните адрес и почту.');
      return;
    }
    const created = requestFromDraft(draft, nextClientRequestNumber(requests));
    setRequests((previous) => [created, ...previous]);
    setDraft({ ...EMPTY_CLIENT_DRAFT, email: draft.email });
    setNotice('Заявка сохранена локально. Клиентский API ещё не подключён.');
    setScreen('list');
  };

  return (
    <main className="min-h-full overflow-x-hidden bg-figma-canvas">
      <div className="engineer-phone client-phone relative h-dvh overflow-hidden">
        <div
          className="flex h-full min-h-0 flex-col overflow-y-auto"
          style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
        >
          <header className="flex items-center" style={{ gap: eu(20) }}>
            <motion.button
              type="button"
              aria-label="Меню"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.16 }}
              className="flex shrink-0 items-center justify-center overflow-hidden bg-figma-ink"
              style={{
                width: eu(90),
                height: eu(90),
                borderRadius: eu(20),
              }}
            >
              <FigmaIcon
                src={CLIENT_ASSETS.menu}
                alt=""
                width={36}
                height={25}
                style={{ width: eu(36), height: eu(25) }}
              />
            </motion.button>
            {screen === 'list' ? (
              <p
                className="min-w-0 font-murs tracking-[-0.02em] text-figma-ink"
                style={{ fontSize: eu(32), position: 'relative', top: 2 }}
              >
                {engineerHeaderStamp(CLIENT_LIST_NOW_MS)}
              </p>
            ) : null}
            {screen === 'new' ? (
              <p
                className="min-w-0 font-murs tracking-[0.02em] text-figma-ink"
                style={{ fontSize: eu(40), position: 'relative', top: 2 }}
              >
                NAVIX
              </p>
            ) : null}
          </header>

          {screen === 'new' ? (
            <ClientNewRequest
              draft={draft}
              notice={notice}
              onChange={setDraft}
              onSubmit={submit}
              onAskAi={() =>
                setNotice('Заявка с AI появится отдельным экраном. Сейчас заполните форму.')
              }
            />
          ) : null}
          {screen === 'list' ? (
            <ClientRequests
              requests={requests}
              notice={notice}
              motionOn={motionOn}
              onOpen={(id) => {
                setOpenedId(id);
                setNotice(null);
              }}
              onNewRequest={() => go('new')}
            />
          ) : null}
          {screen === 'support' ? (
            <ComingSoon
              title="Поддержка"
              body="Чат с поддержкой появится отдельным экраном. Сейчас можно вернуться к заявкам."
              motionOn={motionOn}
              onBack={() => go('list')}
            />
          ) : null}
        </div>

        <AnimatePresence>
          {opened ? (
            <motion.div
              key={`detail-${opened.id}`}
              className="absolute left-0 top-0 z-30 h-full w-full bg-figma-canvas"
              initial={motionOn ? { x: '100%' } : false}
              animate={{ x: '0%' }}
              exit={motionOn ? { x: '100%' } : undefined}
              transition={motionOn ? slide : { duration: 0 }}
            >
              <div className="h-full overflow-y-auto">
                <ClientRequestDetail
                  item={opened}
                  nowMs={CLIENT_DETAIL_NOW_MS}
                  notice={notice}
                  onBack={() => {
                    setOpenedId(null);
                    setNotice(null);
                  }}
                  onChangeTime={() =>
                    setNotice('Смена окна появится после подключения клиентского API.')
                  }
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {overlayOpen ? null : (
          <ClientMenu
            open={menuOpen}
            motionOn={motionOn}
            email={draft.email.trim() || CLIENT_PROFILE.email}
            active={screen}
            onClose={() => setMenuOpen(false)}
            onNavigate={go}
            onNewRequest={() => go('new')}
          />
        )}
      </div>
    </main>
  );
}

function ComingSoon({
  title,
  body,
  motionOn,
  onBack,
}: {
  title: string;
  body: string;
  motionOn: boolean;
  onBack: () => void;
}) {
  return (
    <motion.section
      initial={motionOn ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      style={{ marginTop: eu(40) }}
    >
      <h1 className="font-extrabold tracking-[0.02em] text-figma-ink" style={{ fontSize: eu(36) }}>
        {title}
      </h1>
      <p
        className="font-medium text-figma-muted"
        style={{ marginTop: eu(16), fontSize: eu(20), lineHeight: eu(28) }}
      >
        {body}
      </p>
      <motion.button
        type="button"
        onClick={onBack}
        whileTap={{ scale: 0.98 }}
        className="bg-figma-bee font-semibold text-figma-ink"
        style={{
          marginTop: eu(24),
          borderRadius: eu(20),
          padding: `${eu(18)} ${eu(32)}`,
          fontSize: eu(22),
        }}
      >
        К списку заявок
      </motion.button>
    </motion.section>
  );
}
