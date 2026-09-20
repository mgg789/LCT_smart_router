import { animate, motion, useMotionValue, useReducedMotion } from 'framer-motion';
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DashboardSnapshot } from '../api/types';
import { useArtboardScale, useLetterboxInsets } from './artboardScale';
import { ENGINEER_PORTRAITS, FIGMA_ASSETS } from './assets';
import {
  arrowSpinDelta,
  bestEngineerIndex,
  isRenderedSlot,
  RING_CARD,
  RING_CENTER,
  RING_CHAT_TOP,
  RING_HOLD_CARDS_PER_SEC,
  RING_HOLD_DELAY_MS,
  RING_RENDER_SPAN,
  RING_SEARCH_TOP,
  ringPose,
  ringSlotKeys,
  rotationDeltaFromPointer,
  selectionSpinTarget,
  shortestTurn,
  wheelStep,
  wrapIndex,
} from './engineerRing';
import {
  type EngineerProfile,
  engineerProfilesFromSnapshot,
  isPlausibleEmail,
} from './engineerRoster';
import { FigmaIcon, FigmaText } from './primitives';

const slideEase = [0.22, 1, 0.36, 1] as const;
const tap = { duration: 0.16 };

type CardBind = {
  poolKey: number;
  logical: number;
  root: HTMLDivElement;
  inner: HTMLDivElement;
  title: HTMLElement;
  status: HTMLElement;
  photos: HTMLImageElement[];
};

const RING_POOL = ringSlotKeys();
const RING_POOL_SIZE = RING_RENDER_SPAN * 2 + 1;

/**
 * Figma ENGINEERS (49:5129): selected-engineer dossier plus the five-card ring.
 */
export function EngineersView({
  snapshot,
  selectedEngineerId,
  motionOn,
  busy,
  onSelectEngineer,
  onLinkEmail,
  onDeleteEngineer,
  onSetAvailability,
}: {
  snapshot: DashboardSnapshot | null;
  selectedEngineerId: string | null;
  motionOn: boolean;
  busy: boolean;
  onSelectEngineer: (engineerId: string) => void;
  onLinkEmail: (engineerId: string, email: string) => Promise<void>;
  onDeleteEngineer: (engineerId: string) => Promise<void>;
  onSetAvailability: (engineerId: string, availability: 'online' | 'offline') => void;
}) {
  const reduceMotion = useReducedMotion();
  const scale = useArtboardScale();
  const letterbox = useLetterboxInsets(scale);
  const roster = useMemo(() => engineerProfilesFromSnapshot(snapshot), [snapshot]);
  const centerMv = useMotionValue(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchHeld, setSearchHeld] = useState<number | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const rosterRef = useRef(roster);
  const centerRef = useRef(0);
  const targetRef = useRef(0);
  const focusedRef = useRef(0);
  const tapTargetRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const bindsRef = useRef(new Map<string, CardBind>());
  const animRef = useRef<ReturnType<typeof animate> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const appliedIdRef = useRef<string | null>(null);
  const prevSelectedRef = useRef<string | null | undefined>(undefined);
  const goGenRef = useRef(0);
  const holdTimerRef = useRef<number | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const holdDirRef = useRef(0);
  const holdLastRef = useRef(0);
  const draggingRef = useRef(false);
  const emailOpenRef = useRef(emailOpen);
  const queryRef = useRef(query);
  const searchHeldRef = useRef(searchHeld);

  rosterRef.current = roster;
  emailOpenRef.current = emailOpen;
  queryRef.current = query;
  searchHeldRef.current = searchHeld;

  const focused = roster[focusedIndex] ?? roster[0] ?? null;
  const previousFocusedId = useRef(focused?.id);

  useEffect(() => {
    if (previousFocusedId.current === focused?.id) return;
    previousFocusedId.current = focused?.id;
    setDeleteAsk(false);
    setDeleteError(null);
    setEmailOpen(false);
    setEmailError(null);
  }, [focused?.id]);

  const paint = useCallback((center: number) => {
    const items = rosterRef.current;
    const count = items.length;
    const nearest = count === 0 ? 0 : wrapIndex(Math.round(center), count);
    if (nearest !== focusedRef.current) {
      focusedRef.current = nearest;
      setFocusedIndex(nearest);
    }
    for (const bind of bindsRef.current.values()) {
      if (count === 0) {
        bind.root.style.visibility = 'hidden';
        continue;
      }
      let slot = bind.logical - center;
      if (slot > RING_RENDER_SPAN + 0.5) {
        bind.logical -= RING_POOL_SIZE;
        slot = bind.logical - center;
      } else if (slot < -(RING_RENDER_SPAN + 0.5)) {
        bind.logical += RING_POOL_SIZE;
        slot = bind.logical - center;
      }
      if (!isRenderedSlot(slot)) {
        bind.root.style.visibility = 'hidden';
        bind.root.style.pointerEvents = 'none';
        continue;
      }
      const pose = ringPose(slot);
      const item = items[wrapIndex(bind.logical, count)];
      bind.root.style.visibility = 'visible';
      bind.root.style.pointerEvents = 'auto';
      bind.root.style.zIndex = String(pose.zIndex);
      bind.root.style.transform = `translate3d(${pose.x - RING_CARD.width / 2}px, ${pose.y - RING_CARD.height / 2}px, 0) rotate(${pose.rotateZ}deg)`;
      bind.inner.style.transform = `rotateX(${pose.lean}deg)`;
      if (item) {
        bind.root.dataset.engCard = item.id;
        if (bind.title.textContent !== item.givenName) bind.title.textContent = item.givenName;
        if (bind.status.textContent !== item.cardStatus) bind.status.textContent = item.cardStatus;
        bind.photos.forEach((photo, photoIndex) => {
          photo.style.opacity = photoIndex === item.photoIndex ? '0.75' : '0';
        });
      }
    }
  }, []);

  useEffect(() => {
    rosterRef.current = roster;
    const unsub = centerMv.on('change', (value) => {
      centerRef.current = value;
      paint(value);
    });
    paint(centerMv.get());
    return unsub;
  }, [centerMv, roster, paint]);

  function stopAnim() {
    animRef.current?.stop();
    animRef.current = null;
  }

  function goTo(target: number, select: boolean) {
    stopAnim();
    targetRef.current = target;
    const gen = goGenRef.current + 1;
    goGenRef.current = gen;
    if (!motionOn || reduceMotion) {
      centerMv.set(target);
      centerRef.current = target;
      paint(target);
      if (select) settle(target);
      return;
    }
    animRef.current = animate(centerMv, target, {
      duration: 0.36,
      ease: slideEase,
      onComplete: () => {
        if (gen !== goGenRef.current) return;
        centerMv.set(target);
        if (select) settle(target);
      },
    });
  }

  function settle(value: number) {
    if (rosterRef.current.length === 0) return;
    const snapped = Math.round(value);
    const index = wrapIndex(snapped, rosterRef.current.length);
    targetRef.current = snapped;
    centerMv.set(snapped);
    centerRef.current = snapped;
    paint(snapped);
    const id = rosterRef.current[index]?.id;
    if (id) {
      appliedIdRef.current = id;
      onSelectEngineer(id);
    }
  }

  function spinBy(delta: number) {
    if (rosterRef.current.length === 0 || delta === 0) return;
    const target = Math.round(targetRef.current + delta);
    tapTargetRef.current = target;
    goTo(target, true);
  }

  function stopHold() {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdRafRef.current !== null) {
      window.cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    holdDirRef.current = 0;
  }

  function startHold(delta: number) {
    stopHold();
    holdTimerRef.current = window.setTimeout(() => {
      holdDirRef.current = delta;
      goGenRef.current += 1;
      const from = tapTargetRef.current ?? targetRef.current;
      stopAnim();
      centerMv.set(from);
      centerRef.current = from;
      targetRef.current = from;
      paint(from);
      holdLastRef.current = performance.now();
      const tick = (now: number) => {
        if (holdDirRef.current === 0) return;
        const dt = Math.min(0.05, (now - holdLastRef.current) / 1000);
        holdLastRef.current = now;
        const next = centerRef.current + holdDirRef.current * RING_HOLD_CARDS_PER_SEC * dt;
        targetRef.current = next;
        centerMv.set(next);
        holdRafRef.current = window.requestAnimationFrame(tick);
      };
      holdRafRef.current = window.requestAnimationFrame(tick);
    }, RING_HOLD_DELAY_MS);
  }

  const syncSelection = useEffectEvent((target: number) => goTo(target, false));
  const spinWheel = useEffectEvent((delta: number) => spinBy(delta));

  useEffect(() => {
    const prevSelected = prevSelectedRef.current;
    prevSelectedRef.current = selectedEngineerId;
    if (roster.length === 0) return;
    if (query.trim() || searchHeld !== null || draggingRef.current) return;
    if (holdDirRef.current !== 0 || animRef.current) return;
    if (prevSelected === selectedEngineerId && prevSelected !== undefined) return;
    const index = selectedEngineerId
      ? roster.findIndex((item) => item.id === selectedEngineerId)
      : 0;
    const target = selectionSpinTarget(centerRef.current, index < 0 ? 0 : index, roster.length);
    if (target === null) return;
    appliedIdRef.current = roster[index < 0 ? 0 : index]?.id ?? null;
    syncSelection(target);
  }, [query, roster, searchHeld, selectedEngineerId]);

  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (rosterRef.current.length === 0) return;
      spinWheel(wheelStep(event.deltaY));
    };
    ring.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => ring.removeEventListener('wheel', onNativeWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (emailOpenRef.current) {
          setEmailOpen(false);
          setEmailError(null);
          return;
        }
        if (queryRef.current || searchHeldRef.current !== null) {
          event.preventDefault();
          actionsRef.current.clearSearch();
        }
        return;
      }
      if (event.repeat) return;
      if (isTypingTarget(event.target)) return;
      const delta = arrowSpinDelta(event.key);
      if (delta === null) return;
      event.preventDefault();
      actionsRef.current.spinBy(delta);
      actionsRef.current.startHold(delta);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const dir = holdDirRef.current;
      const tapTarget = tapTargetRef.current;
      actionsRef.current.stopHold();
      if (dir === 0) return;
      let value = centerRef.current;
      if (tapTarget !== null) {
        value = dir < 0 ? Math.min(value, tapTarget) : Math.max(value, tapTarget);
      }
      actionsRef.current.settle(value);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      actionsRef.current.stopHold();
    };
  }, []);

  function artboardPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: event.clientX, y: event.clientY };
    const scale = rect.width / 1920;
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-eng-chrome]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { ...artboardPoint(event), moved: false };
    draggingRef.current = true;
    stopHold();
    stopAnim();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const prev = pointerRef.current;
    if (!prev) return;
    const next = artboardPoint(event);
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (!prev.moved && dx * dx + dy * dy < 16) return;
    pointerRef.current = { ...next, moved: true };
    const value = centerRef.current + rotationDeltaFromPointer(prev, next);
    targetRef.current = value;
    centerMv.set(value);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const prev = pointerRef.current;
    pointerRef.current = null;
    draggingRef.current = false;
    if (!prev) return;
    if (!prev.moved) {
      const card = (event.target as HTMLElement)
        .closest('[data-eng-card]')
        ?.getAttribute('data-eng-card');
      if (card) {
        const index = roster.findIndex((item) => item.id === card);
        if (index >= 0) {
          goTo(centerRef.current + shortestTurn(centerRef.current, index, roster.length), true);
          return;
        }
      }
      if (query.trim() || searchHeld !== null) {
        clearSearch();
      }
      return;
    }
    settle(centerRef.current);
  }

  function onSearchChange(value: string) {
    if (!value.trim()) {
      clearSearch();
      return;
    }
    if (searchHeld === null) setSearchHeld(centerRef.current);
    setQuery(value);
    const hit = bestEngineerIndex(
      roster.map((item) => ({ name: item.displayName, email: item.email })),
      value,
      centerRef.current,
    );
    if (hit === null) return;
    goTo(centerRef.current + shortestTurn(centerRef.current, hit, roster.length), true);
  }

  function clearSearch() {
    const restore = searchHeldRef.current;
    setQuery('');
    setSearchHeld(null);
    if (restore !== null) goTo(restore, true);
  }

  const actionsRef = useRef({
    spinBy,
    startHold,
    stopHold,
    settle,
    clearSearch,
  });
  actionsRef.current = { spinBy, startHold, stopHold, settle, clearSearch };

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    if (!focused) return;
    const next = emailDraft.trim();
    if (!next) {
      setEmailError('Укажите адрес почты');
      return;
    }
    if (!isPlausibleEmail(next)) {
      setEmailError('Проверьте адрес почты');
      return;
    }
    setEmailBusy(true);
    setEmailError(null);
    try {
      await onLinkEmail(focused.id, next);
      setEmailOpen(false);
    } catch (cause) {
      setEmailError(cause instanceof Error ? cause.message : 'Не удалось сохранить почту');
    } finally {
      setEmailBusy(false);
    }
  }

  async function confirmDelete() {
    if (!focused) return;
    setEmailBusy(true);
    setDeleteError(null);
    try {
      await onDeleteEngineer(focused.id);
      setDeleteAsk(false);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Не удалось удалить инженера');
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <section ref={stageRef} className="engineer-ring-page absolute inset-0" data-name="ENGINEERS">
      {focused ? (
        <EngineerDossier
          engineer={focused}
          motionOn={motionOn}
          busy={busy || emailBusy}
          emailOpen={emailOpen}
          emailDraft={emailDraft}
          emailError={emailError}
          deleteAsk={deleteAsk}
          deleteError={deleteError}
          onToggleEmail={() => {
            setEmailOpen((open) => !open);
            setEmailDraft(focused.email ?? '');
            setEmailError(null);
          }}
          onEmailDraft={setEmailDraft}
          onSubmitEmail={(event) => void submitEmail(event)}
          onAvailability={() => {
            onSetAvailability(
              focused.id,
              focused.availability === 'offline' ? 'online' : 'offline',
            );
          }}
          onAskDelete={() => {
            setDeleteAsk(true);
            setDeleteError(null);
          }}
          onCancelDelete={() => {
            setDeleteAsk(false);
            setDeleteError(null);
          }}
          onConfirmDelete={() => void confirmDelete()}
        />
      ) : (
        <div
          className="absolute z-10 overflow-hidden rounded-[20px] bg-white"
          style={{ left: 180, top: 132, width: 1710, height: 418 }}
        >
          <div className="absolute inset-y-0 left-0 w-[274px] bg-figma-ink" />
          <FigmaText className="absolute left-[306px] top-[35px] font-murs text-[32px] tracking-[0.64px] text-figma-ink">
            Нет инженеров
          </FigmaText>
        </div>
      )}

      <div
        ref={ringRef}
        className="engineer-ring-stage absolute inset-0"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {RING_POOL.map((slotKey) => (
          <EngineerRingCard
            key={slotKey}
            slotKey={slotKey}
            onBind={(bind) => {
              if (bind) bindsRef.current.set(String(bind.poolKey), bind);
              else bindsRef.current.delete(String(slotKey));
              paint(centerRef.current);
            }}
          />
        ))}
      </div>
      <div
        className="engineer-ring-blur-layer"
        style={{ top: 0, right: -80, bottom: -letterbox.y, left: -80 }}
      >
        <div className="engineer-ring-blur-veil engineer-ring-blur-veil-left" />
        <div className="engineer-ring-blur-veil engineer-ring-blur-veil-right" />
      </div>
      <div
        className="engineer-ring-fog"
        style={{ top: 0, right: -40, bottom: -letterbox.y, left: -40 }}
      />

      {focused ? (
        <motion.button
          type="button"
          data-eng-chrome
          disabled
          aria-disabled
          title="Скоро"
          className="absolute z-20 flex h-[51px] w-[225px] cursor-not-allowed items-center rounded-[27px] bg-figma-bee px-[16px] opacity-45"
          style={{ left: RING_CENTER.x - 112.5, top: RING_CHAT_TOP }}
        >
          <FigmaText className="font-bold text-[20px] text-figma-ink">Перейти в чат</FigmaText>
          <FigmaIcon
            src={FIGMA_ASSETS.engChat}
            alt=""
            width={43}
            height={43}
            className="absolute right-[4px] top-1/2 -translate-y-1/2"
          />
        </motion.button>
      ) : null}

      <motion.label
        data-eng-chrome
        className="absolute z-20 flex h-[51px] w-[284px] origin-center items-center rounded-[27px] bg-white px-[16px] pr-[54px]"
        style={{ left: 895, top: RING_SEARCH_TOP }}
        animate={
          !motionOn || reduceMotion
            ? undefined
            : searchFocused
              ? { scale: 1.045, boxShadow: '0 10px 28px rgba(39,41,48,0.12)' }
              : { scale: 1, boxShadow: '0 0 0 rgba(39,41,48,0)' }
        }
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder="Найти инженера"
          className="w-full bg-transparent font-medium text-[16px] text-figma-ink outline-none placeholder:text-figma-ink"
        />
        <motion.button
          type="button"
          className="absolute right-[4px] top-1/2 size-[43px] -translate-y-1/2"
          aria-label="Найти инженера"
          onClick={() => searchInputRef.current?.focus()}
          animate={!motionOn || reduceMotion ? undefined : { scale: searchFocused ? 1.1 : 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <FigmaIcon src={FIGMA_ASSETS.engSearch} alt="" width={43} height={43} />
        </motion.button>
      </motion.label>
    </section>
  );
}

function EngineerDossier({
  engineer,
  motionOn,
  busy,
  emailOpen,
  emailDraft,
  emailError,
  deleteAsk,
  deleteError,
  onToggleEmail,
  onEmailDraft,
  onSubmitEmail,
  onAvailability,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  engineer: EngineerProfile;
  motionOn: boolean;
  busy: boolean;
  emailOpen: boolean;
  emailDraft: string;
  emailError: string | null;
  deleteAsk: boolean;
  deleteError: string | null;
  onToggleEmail: () => void;
  onEmailDraft: (value: string) => void;
  onSubmitEmail: (event: FormEvent) => void;
  onAvailability: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const portrait = ENGINEER_PORTRAITS[engineer.photoIndex] ?? ENGINEER_PORTRAITS[0];
  const offline = engineer.availability === 'offline';

  return (
    <div
      className="absolute z-10 overflow-hidden rounded-[20px] bg-white"
      style={{ left: 180, top: 132, width: 1710, height: 418 }}
    >
      <div className="absolute inset-y-0 left-0 w-[274px] overflow-hidden bg-figma-ink">
        <img
          src={portrait}
          alt=""
          className="absolute left-[-132px] top-0 size-[418px] object-cover blur-[15px]"
        />
        <div className="absolute inset-0 bg-figma-ink" />
      </div>

      <div className="absolute bottom-[32px] left-[306px] right-[48px] top-[35px] flex flex-col">
        <FigmaText className="figma-nowrap font-murs text-[32px] tracking-[0.64px] text-figma-ink">
          {engineer.displayName}
        </FigmaText>

        <div className="mt-[16px] flex min-h-[32px] items-center gap-[10px]">
          {emailOpen ? (
            <form className="flex min-w-0 items-center gap-[10px]" onSubmit={onSubmitEmail}>
              <input
                value={emailDraft}
                onChange={(event) => onEmailDraft(event.target.value)}
                className="h-[32px] w-[320px] shrink-0 rounded-full bg-figma-track px-[14px] font-semibold text-[18px] text-figma-ink outline-none"
                placeholder="email@example.com"
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy}
                className="shrink-0 font-semibold text-[16px] text-figma-ink disabled:opacity-50"
              >
                Сохранить
              </button>
              <button
                type="button"
                onClick={onToggleEmail}
                className="shrink-0 font-semibold text-[16px] text-figma-muted"
              >
                Отмена
              </button>
              {emailError ? (
                <p className="figma-nowrap min-w-0 truncate font-medium text-[14px] text-figma-cancel">
                  {emailError}
                </p>
              ) : null}
            </form>
          ) : (
            <>
              <FigmaText className="font-semibold text-[20px] tracking-[-0.34px] text-figma-muted">
                {engineer.email ?? 'Почта не привязана'}
              </FigmaText>
              <button type="button" aria-label="Изменить почту" onClick={onToggleEmail}>
                <FigmaIcon src={FIGMA_ASSETS.engEdit} alt="" width={24} height={24} />
              </button>
            </>
          )}
        </div>

        <div className="mt-[16px] flex flex-wrap gap-[12px]">
          {engineer.skillLabels.map((label) => (
            <span
              key={label}
              className="inline-flex h-[44px] items-center rounded-full bg-figma-track px-[20px] font-medium text-[20px] tracking-[-0.34px] text-figma-ink"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="mt-auto grid h-[201px] grid-cols-2 gap-[48px]">
          <div className="flex h-full flex-col">
            <FactRow
              icon={FIGMA_ASSETS.engTransport}
              label="Транспорт"
              value={engineer.transportLabel}
            />
            <FactRow icon={FIGMA_ASSETS.engOffice} label="Офис" value={engineer.officeLabel} />
            <div className="mt-auto flex gap-[38px]">
              <motion.button
                type="button"
                disabled={busy}
                className="flex h-[67px] w-[241px] items-center justify-center rounded-[20px] bg-figma-bee font-semibold text-[20px] tracking-[-0.6px] text-figma-ink disabled:opacity-50"
                whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
                whileTap={motionOn ? { scale: 0.98 } : undefined}
                transition={tap}
                onClick={onAvailability}
              >
                {offline ? 'Вернуть на смену' : 'Снять со смены'}
              </motion.button>
              {deleteAsk ? (
                <div className="flex flex-col gap-[8px]">
                  <div className="flex gap-[12px]">
                    <button
                      type="button"
                      disabled={busy}
                      className="flex h-[67px] w-[114px] items-center justify-center rounded-[20px] bg-figma-track font-semibold text-[16px] text-figma-ink disabled:opacity-50"
                      onClick={onCancelDelete}
                    >
                      Отмена
                    </button>
                    <motion.button
                      type="button"
                      disabled={busy}
                      className="flex h-[67px] w-[115px] items-center justify-center rounded-[20px] bg-figma-cancel font-semibold text-[16px] text-[#f1f1f1] disabled:opacity-50"
                      whileHover={
                        motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined
                      }
                      whileTap={motionOn ? { scale: 0.98 } : undefined}
                      transition={tap}
                      onClick={onConfirmDelete}
                    >
                      Удалить
                    </motion.button>
                  </div>
                  {deleteError ? (
                    <p className="figma-nowrap max-w-[241px] truncate font-medium text-[14px] text-figma-cancel">
                      {deleteError}
                    </p>
                  ) : null}
                </div>
              ) : (
                <motion.button
                  type="button"
                  disabled={busy}
                  className="flex h-[67px] w-[241px] items-center justify-center rounded-[20px] bg-figma-cancel font-semibold text-[20px] tracking-[-0.6px] text-[#f1f1f1] disabled:opacity-50"
                  whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
                  whileTap={motionOn ? { scale: 0.98 } : undefined}
                  transition={tap}
                  onClick={onAskDelete}
                >
                  Удалить
                </motion.button>
              )}
            </div>
          </div>

          <EngineerActivityPane engineer={engineer} />
        </div>
      </div>
    </div>
  );
}

function FactRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex h-[36px] items-center border-b border-[#e6e6e6]">
      <FigmaIcon src={icon} alt="" width={20} height={20} />
      <FigmaText className="ml-[10px] w-[124px] font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
        {label}
      </FigmaText>
      <FigmaText className="font-semibold text-[18px] tracking-[-0.54px] text-figma-muted">
        {value}
      </FigmaText>
    </div>
  );
}

function EngineerActivityPane({ engineer }: { engineer: EngineerProfile }) {
  const activity = engineer.activity;
  if (activity.kind === 'empty') return <div />;

  if (activity.kind !== 'job') {
    return (
      <div className="flex h-full flex-col border-l border-[#e6e6e6] pl-[48px]">
        <FigmaText className="font-murs text-[32px] tracking-[0.64px] text-black">
          {activity.title}
        </FigmaText>
        {activity.untilClock ? (
          <FigmaText className="mt-auto font-murs text-[64px] tracking-[1.28px] text-black">
            {activity.untilClock}
          </FigmaText>
        ) : null}
        <FigmaText className="mt-[8px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
          {activity.kind === 'lunch' ? 'Ожидаемое завершение' : 'Ожидаемое возвращение'}
        </FigmaText>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-[#e6e6e6] pl-[48px]">
      <FigmaText className="font-murs text-[32px] tracking-[0.64px] text-black">
        {activity.title}
      </FigmaText>
      <div className="mt-[8px] flex flex-wrap items-center gap-[8px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        <span>{activity.address}</span>
        {activity.client ? (
          <>
            <FigmaIcon src={FIGMA_ASSETS.engDot} alt="" width={5} height={5} />
            <span>клиент “{activity.client}”</span>
          </>
        ) : null}
        {activity.arrived ? (
          <>
            <FigmaIcon src={FIGMA_ASSETS.engDot} alt="" width={5} height={5} />
            <span>{activity.arrived}</span>
          </>
        ) : null}
      </div>
      <FigmaText className="mt-auto font-murs text-[64px] tracking-[1.28px] text-black">
        {activity.finishClock}
      </FigmaText>
      <div className="mt-[8px] flex flex-wrap items-center gap-[8px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        <span>Ожидаемое завершение</span>
        {activity.nextClock ? (
          <>
            <FigmaIcon src={FIGMA_ASSETS.engDot} alt="" width={5} height={5} />
            <span>Следующая заявка в {activity.nextClock}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function EngineerRingCard({
  slotKey,
  onBind,
}: {
  slotKey: number;
  onBind: (bind: CardBind | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const photosRef = useRef<HTMLImageElement[]>([]);
  const onBindRef = useRef(onBind);
  onBindRef.current = onBind;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const inner = innerRef.current;
    const title = titleRef.current;
    const status = statusRef.current;
    if (!root || !inner || !title || !status) return;
    onBindRef.current({
      poolKey: slotKey,
      logical: slotKey,
      root,
      inner,
      title,
      status,
      photos: photosRef.current,
    });
    return () => onBindRef.current(null);
  }, [slotKey]);

  return (
    <div
      ref={rootRef}
      data-eng-card=""
      className="engineer-ring-card absolute left-0 top-0"
      style={{
        width: RING_CARD.width,
        height: RING_CARD.height,
        willChange: 'transform',
      }}
    >
      <div
        ref={innerRef}
        className="engineer-ring-card-face relative h-full w-full overflow-hidden rounded-[20px] bg-[#2c2c2c]"
      >
        {ENGINEER_PORTRAITS.map((src, photoIndex) => (
          <img
            key={src}
            ref={(node) => {
              if (node) photosRef.current[photoIndex] = node;
            }}
            src={src}
            alt=""
            className="pointer-events-none absolute left-[91px] top-[-12px] size-[254px] object-cover blur-[15px] opacity-0"
          />
        ))}
        <div className="pointer-events-none absolute inset-0 bg-[#272930]/25" />
        <div className="absolute bottom-[14px] left-[26px] right-[26px] pb-[4px]">
          <p
            ref={titleRef}
            className="figma-text figma-text-keep-descenders figma-nowrap overflow-hidden text-ellipsis font-murs text-[24px] leading-[30px] tracking-[0.48px] text-white"
          />
          <p
            ref={statusRef}
            className="figma-nowrap mt-[4px] overflow-hidden text-ellipsis font-extrabold text-[18px] leading-[22px] tracking-[0.36px] text-[#ededed]"
          />
        </div>
      </div>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable="true"]'));
}
