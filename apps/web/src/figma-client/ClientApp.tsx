import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { DashboardApiError } from '../api/client';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { DeskShell } from '../figma-engineer/DeskShell';
import { engineerHeaderStamp } from '../figma-engineer/engineerClock';
import { eu } from '../figma-engineer/engineerScale';
import { PhoneErrorNotice } from '../figma-engineer/PhoneErrorNotice';
import { usePhoneDesk } from '../figma-engineer/phoneDesk';
import { isPhoneFailureNotice } from '../figma-engineer/phoneNotice';
import { CLIENT_ASSETS } from './assets';
import { ClientAiPane } from './ClientAiPane';
import { ClientEmailGate } from './ClientEmailGate';
import { ClientMenu } from './ClientMenu';
import { ClientNewRequest } from './ClientNewRequest';
import { ClientRequestDetail } from './ClientRequestDetail';
import { ClientRequests } from './ClientRequests';
import { ClientSent } from './ClientSent';
import {
  clientCardFromApi,
  createSubmittedClientRequest,
  loadClientHistory,
  loadClientProfile,
  loadClientRequest,
  requestClientLoginCode,
  verifyClientLoginCode,
} from './clientApi';
import {
  type ClientRequestDraft,
  type ClientRequestView,
  type ClientScreenId,
  clientSubmitHint,
  EMPTY_CLIENT_DRAFT,
  prefillClientDraft,
} from './clientPreview';
import { clientRequestIdFromPath, clientRequestPath } from './clientRequestSeo';
import {
  clearClientSession,
  readClientSession,
  type StoredClientSession,
  writeClientSession,
} from './clientSession';

const slideEase = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease: slideEase };

type GatePurpose = 'submit' | 'list' | 'detail' | 'support';

interface EmailGateState {
  purpose: GatePurpose;
  email: string;
  codeStep: boolean;
  devCode?: string;
  requestId?: string;
}

/**
 * Client App: new request without an account, email code before the request
 * exists, then the history of that address.
 */
export function ClientApp() {
  const motionOn = !useReducedMotion();
  const desk = usePhoneDesk();
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<ClientScreenId>('new');
  const [draft, setDraft] = useState<ClientRequestDraft>(EMPTY_CLIENT_DRAFT);
  const [requests, setRequests] = useState<ClientRequestView[]>([]);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [newMode, setNewMode] = useState<'story' | 'form'>('form');
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<StoredClientSession | null>(null);
  const [gate, setGate] = useState<EmailGateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ClientRequestView | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const opened = requests.find((item) => item.id === openedId) ?? null;

  // Declared before the effects that reference it, and memoised: it sits in their
  // dependency arrays and must not change identity on every render.
  const forgetSession = useCallback(() => {
    clearClientSession(window.localStorage);
    setSession(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    const stored = readClientSession(window.localStorage);
    setSession(stored);
    if (!stored) {
      const id = clientRequestIdFromPath(window.location.pathname);
      if (id) {
        setGate({ purpose: 'detail', email: '', codeStep: false, requestId: id });
      }
    }
    const onPop = () => {
      const id = clientRequestIdFromPath(window.location.pathname);
      setOpenedId(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    loadClientProfile(session.token)
      .then((profile) => {
        if (!cancelled) setDraft((current) => prefillClientDraft(current, profile));
      })
      .catch((error: unknown) => {
        if (!cancelled && isDeadSession(error)) forgetSession();
      });
    const pendingId = clientRequestIdFromPath(window.location.pathname);
    if (pendingId) {
      loadClientRequest(session.token, pendingId)
        .then((row) => {
          if (cancelled) return;
          const card = clientCardFromApi(row);
          setRequests((previous) =>
            previous.some((item) => item.id === card.id) ? previous : [card, ...previous],
          );
          setOpenedId(card.id);
          setScreen('list');
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (isDeadSession(error)) forgetSession();
          else setNotice(errorText(error));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [session, forgetSession]);

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const remember = (next: StoredClientSession) => {
    writeClientSession(window.localStorage, next);
    setSession(next);
    setDraft((current) => ({ ...current, email: next.email }));
  };

  const refreshHistory = async (token: string) => {
    const rows = await loadClientHistory(token);
    const cards = rows.map(clientCardFromApi);
    setRequests(cards);
    return cards;
  };

  const openOwned = async (active: StoredClientSession, id: string) => {
    try {
      const card = clientCardFromApi(await loadClientRequest(active.token, id));
      setRequests((previous) =>
        previous.some((item) => item.id === card.id) ? previous : [card, ...previous],
      );
      setOpenedId(card.id);
      setScreen('list');
      if (window.location.pathname !== clientRequestPath(card.id)) {
        window.history.pushState({}, '', clientRequestPath(card.id));
      }
    } catch (error) {
      setNotice(errorText(error));
      setOpenedId(null);
    }
  };

  const go = (next: ClientScreenId) => {
    setOpenedId(null);
    setScreen(next);
    setMenuOpen(false);
    setNotice(null);
    setGate(null);
    if (window.location.pathname !== '/client' && window.location.pathname !== '/client/') {
      window.history.pushState({}, '', '/client');
    }
  };

  const openList = () => {
    setMenuOpen(false);
    setNotice(null);
    if (!session) {
      setGate({
        purpose: 'list',
        email: draft.email.trim(),
        codeStep: false,
      });
      return;
    }
    setScreen('list');
    setNowMs(Date.now());
    void refreshHistory(session.token).catch((error: unknown) => {
      if (isDeadSession(error)) forgetSession();
      else setNotice(errorText(error));
    });
  };

  const submit = () => {
    const hint = clientSubmitHint(draft);
    if (hint) {
      setNotice(hint);
      return;
    }
    const email = draft.email.trim().toLowerCase();
    if (session && session.email === email) {
      void sendNow(session);
      return;
    }
    setNotice(null);
    setGate({ purpose: 'submit', email, codeStep: false });
    void askCode(email);
  };

  const askCode = async (email: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const issued = await requestClientLoginCode(email);
      setGate((current) =>
        current
          ? { ...current, email: issued.email, codeStep: true, devCode: issued.devCode }
          : current,
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (code: string) => {
    if (!gate) return;
    setBusy(true);
    setNotice(null);
    try {
      const issued = await verifyClientLoginCode(gate.email, code);
      const next = {
        token: issued.token,
        email: issued.email,
        expiresAt: issued.expiresAt,
      };
      remember(next);
      setGate(null);
      if (gate.purpose === 'submit') {
        await sendNow(next);
        return;
      }
      if (gate.purpose === 'support') {
        setScreen('support');
        return;
      }
      const cards = await refreshHistory(next.token);
      setScreen('list');
      setNowMs(Date.now());
      if (gate.purpose === 'detail' && gate.requestId) {
        const found = cards.find((item) => item.id === gate.requestId);
        if (found) {
          setOpenedId(found.id);
          window.history.pushState({}, '', clientRequestPath(found.id));
        } else {
          await openOwned(next, gate.requestId);
        }
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async (active: StoredClientSession) => {
    setBusy(true);
    setNotice(null);
    try {
      const created = clientCardFromApi(await createSubmittedClientRequest(active.token, draft));
      setRequests((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
      setSent(created);
      setScreen('sent');
      setDraft((current) => ({
        ...EMPTY_CLIENT_DRAFT,
        email: active.email,
        contactName: current.contactName,
        address: current.address,
        point: current.point,
      }));
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const openCard = (id: string) => {
    setOpenedId(id);
    setNotice(null);
    window.history.pushState({}, '', clientRequestPath(id));
  };

  const failure = isPhoneFailureNotice(notice) ? notice : null;
  const inlineNotice = failure ? null : notice;

  const closeDetail = () => {
    setOpenedId(null);
    setNotice(null);
    if (window.location.pathname.startsWith('/client/requests/')) {
      window.history.pushState({}, '', '/client');
    }
  };

  const detail = opened ? (
    <ClientRequestDetail
      item={opened}
      nowMs={nowMs}
      notice={inlineNotice}
      onBack={closeDetail}
      onChangeTime={() => setNotice('Смена окна этой заявки появится отдельным шагом.')}
    />
  ) : null;

  const gateSheet = (
    <AnimatePresence>
      {gate ? (
        <motion.div
          key="client-email-gate"
          className="absolute inset-0 z-40 bg-figma-canvas"
          initial={motionOn ? { y: 24, opacity: 0 } : false}
          animate={{ y: 0, opacity: 1 }}
          exit={motionOn ? { y: 24, opacity: 0 } : undefined}
          transition={motionOn ? slide : { duration: 0 }}
        >
          {/* The sheet covers the pane; the form inside it keeps a column of
              its own, at a scale that matches that column's width. */}
          <div className={desk ? 'phone-desk-sheet h-full' : 'h-full'}>
            <ClientEmailGate
              purpose={gate.purpose}
              email={gate.email}
              codeStep={gate.codeStep}
              devCode={gate.devCode}
              busy={busy}
              notice={inlineNotice}
              onEmailChange={(email) => setGate({ ...gate, email })}
              onRequestCode={() => {
                void askCode(gate.email.trim());
              }}
              onConfirm={(code) => {
                void confirmCode(code);
              }}
              onClose={() => {
                setGate(null);
                setNotice(null);
              }}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  /**
   * The same menu twice over: a drawer behind a button on the phone, and the
   * rail itself on a desk, where there is room for it to simply be there.
   */
  const deskMenu = (
    <ClientMenu
      active={screen === 'sent' ? 'new' : screen}
      docked
      email={session?.email ?? null}
      motionOn={motionOn}
      onClose={() => undefined}
      onNavigate={(id) => {
        if (id === 'list') openList();
        else go(id);
      }}
      onNewRequest={() => go('new')}
      open
    />
  );

  const menuDrawer = (
    <ClientMenu
      active={screen === 'sent' ? 'new' : screen}
      email={session?.email ?? null}
      motionOn={motionOn}
      onClose={() => setMenuOpen(false)}
      onNavigate={(id) => {
        if (id === 'list') openList();
        else go(id);
      }}
      onNewRequest={() => go('new')}
      open={menuOpen}
    />
  );

  const column = (
    <>
      {failure ? (
        <PhoneErrorNotice title="Ошибка" body={failure} onClose={() => setNotice(null)} />
      ) : null}
      {/*
       * On a desk the list is the one screen worth the whole width; a form is
       * not, so it keeps a readable column in the middle.
       */}
      <div
        className={`flex h-full min-h-0 flex-col ${screen === 'support' ? 'overflow-hidden' : 'overflow-y-auto'} ${
          desk && screen !== 'list'
            ? screen === 'new' && newMode === 'story'
              ? 'phone-desk-column'
              : 'phone-desk-center'
            : ''
        }`}
        style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
      >
        <header className={`flex items-center ${desk ? 'hidden' : ''}`} style={{ gap: eu(20) }}>
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
              {engineerHeaderStamp(nowMs)}
            </p>
          ) : null}
          {screen === 'new' || screen === 'sent' ? (
            <p
              className="min-w-0 font-murs tracking-[0.02em] text-figma-ink"
              style={{ fontSize: eu(40), position: 'relative', top: 1 }}
            >
              NAVIX
            </p>
          ) : null}
        </header>

        {screen === 'new' ? (
          <ClientNewRequest
            onModeChange={setNewMode}
            draft={draft}
            busy={busy}
            notice={busy ? 'Отправляем…' : inlineNotice}
            onChange={setDraft}
            onSubmit={submit}
          />
        ) : null}
        {screen === 'sent' && sent ? (
          <ClientSent
            item={sent}
            onList={openList}
            onAnother={() => {
              setSent(null);
              go('new');
            }}
          />
        ) : null}
        {screen === 'list' ? (
          <ClientRequests
            requests={requests}
            notice={inlineNotice}
            motionOn={motionOn}
            onOpen={openCard}
            onNewRequest={() => go('new')}
            selectedId={openedId}
          />
        ) : null}
        {screen === 'support' ? (
          <div className="relative min-h-0 flex-1" style={{ marginTop: eu(24) }}>
            {session ? (
              <ClientAiPane
                token={session.token}
                sessionScope={session.email}
                onSessionExpired={forgetSession}
                displayName={draft.contactName || null}
                onOperationApplied={() => {
                  void refreshHistory(session.token).catch((error: unknown) => {
                    if (isDeadSession(error)) forgetSession();
                    else setNotice(errorText(error));
                  });
                }}
                onOpenRequest={(id) => void openOwned(session, id)}
              />
            ) : (
              <button
                type="button"
                className="rounded-full bg-figma-bee px-6 py-4 font-semibold"
                onClick={() => setGate({ purpose: 'support', email: draft.email, codeStep: false })}
              >
                Войти и открыть ассистента
              </button>
            )}
          </div>
        ) : null}
      </div>

      <AnimatePresence>
        {opened && !desk ? (
          <motion.div
            key={`detail-${opened.id}`}
            className="absolute left-0 top-0 z-30 h-full w-full bg-figma-canvas"
            initial={motionOn ? { x: '100%' } : false}
            animate={{ x: '0%' }}
            exit={motionOn ? { x: '100%' } : undefined}
            transition={motionOn ? slide : { duration: 0 }}
          >
            <div className="h-full overflow-y-auto">{detail}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {gateSheet}

      {desk || (opened && !desk) || gate ? null : menuDrawer}
    </>
  );

  if (desk) {
    return (
      <DeskShell
        menu={deskMenu}
        detail={detail}
        detailKey={opened?.id}
        header={
          <>
            <p className="font-murs text-[28px] tracking-[0.02em] text-figma-ink">NAVIX</p>
            <span className="flex-1" />
            {session?.email ? (
              <p className="font-medium text-[16px] text-figma-muted">{session.email}</p>
            ) : null}
          </>
        }
        fitScreen={desk && ((screen === 'new' && newMode === 'form') || screen === 'sent')}
        screenKey={screen}
      >
        {column}
      </DeskShell>
    );
  }

  return (
    <main className="min-h-full overflow-x-hidden bg-figma-canvas">
      <div className="engineer-phone client-phone relative h-dvh overflow-hidden">{column}</div>
    </main>
  );
}

function isDeadSession(error: unknown): boolean {
  return (
    error instanceof DashboardApiError &&
    (error.status === 401 || /no longer valid|authentication is required/i.test(error.message))
  );
}

function errorText(error: unknown): string {
  if (isDeadSession(error)) return 'Сессия закончилась. Войдите по почте ещё раз.';
  if (error instanceof DashboardApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Не удалось выполнить запрос.';
}
