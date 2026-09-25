import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CONNECTION_TYPES,
  type ObjectPassport,
  passportInputSchema,
  savePassport,
} from '../../api/passports';
import { announcePassportSaved, usePassport } from './usePassport';

const fieldClass =
  'mt-1 w-full rounded-[20px] border border-figma-ink/20 bg-white p-3 text-base text-figma-ink focus:outline-2 focus:outline-figma-bee';

/** Mounted only under the current card; the server independently checks fill eligibility. */
export function PassportOffer({ token, requestId }: { token: string; requestId: string }) {
  const { data, error, refresh } = usePassport(token, 'engineer', requestId);
  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [rewardVisible, setRewardVisible] = useState(false);
  useEffect(() => {
    if (!rewardVisible) return;
    const timer = window.setTimeout(() => setRewardVisible(false), 3_200);
    return () => window.clearTimeout(timer);
  }, [rewardVisible]);
  const continueAfterSuccess = useCallback(() => {
    setSuccessOpen(false);
    setRewardVisible(true);
  }, []);
  if (error)
    return (
      <div className="mt-3 text-sm text-figma-muted">
        <span>{error}. </span>
        <button type="button" onClick={refresh} className="underline">
          Повторить
        </button>
      </div>
    );
  if (data?.unavailableReason === 'ADDRESS_NOT_RESOLVED') {
    return (
      <p className="mt-3 text-sm text-figma-muted">
        Не удалось определить здание для паспорта.{' '}
        <button type="button" onClick={refresh} className="underline">
          Повторить
        </button>
      </p>
    );
  }
  if ((!data?.canFill || completed) && !successOpen && !rewardVisible) return null;
  return (
    <>
      {data?.canFill && !completed ? (
        <div className="my-4 border-y border-figma-ink/20 py-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center justify-between gap-3 rounded-[20px] bg-figma-bee p-4 text-left font-semibold text-figma-ink"
          >
            <span>{data?.passport ? 'Обновить паспорт' : 'Заполнить паспорт'}</span>
            <span className="shrink-0 text-sm">+35 баллов</span>
          </button>
        </div>
      ) : null}
      <AnimatePresence>
        {rewardVisible ? (
          <motion.p
            role="status"
            className="my-3 rounded-full bg-figma-work-bg px-4 py-3 text-center text-sm font-semibold text-figma-work"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            Паспорт сохранён · +35 баллов
          </motion.p>
        ) : null}
      </AnimatePresence>
      {open ? (
        <PassportForm
          token={token}
          requestId={requestId}
          passport={data?.passport ?? null}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setCompleted(true);
            setSuccessOpen(true);
            announcePassportSaved();
            refresh();
          }}
        />
      ) : null}
      <AnimatePresence>
        {successOpen ? <PassportSuccessScreen onContinue={continueAfterSuccess} /> : null}
      </AnimatePresence>
    </>
  );
}

/** Full-screen confirmation adapted from Figma node 155:2682. */
export function PassportSuccessScreen({ onContinue }: { onContinue: () => void }) {
  const reduceMotion = useReducedMotion();
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    continueRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onContinue();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [onContinue]);
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const };
  return createPortal(
    <motion.section
      className="fixed inset-0 z-[120] flex min-h-[100dvh] items-center justify-center bg-figma-canvas px-6 text-figma-ink"
      role="dialog"
      aria-modal="true"
      aria-labelledby="passport-success-title"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0 }}
      transition={transition}
    >
      <div className="flex w-full max-w-[430px] -translate-y-[3dvh] flex-col items-center text-center">
        <motion.img
          src="/figma/logo-dark.png"
          alt="NAVIX"
          className="size-[108px] object-contain"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...transition, delay: reduceMotion ? 0 : 0.04 }}
        />
        <p className="mt-4 font-murs text-[42px] tracking-[0.02em]">NAVIX</p>
        <motion.img
          src="/figma/passport-success-check.svg"
          alt=""
          className="mt-16 size-[160px]"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...transition, delay: reduceMotion ? 0 : 0.12 }}
        />
        <motion.h2
          id="passport-success-title"
          className="mt-5 text-[24px] font-semibold text-figma-dim"
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...transition, delay: reduceMotion ? 0 : 0.22 }}
        >
          Данные заполнены
        </motion.h2>
        <motion.button
          ref={continueRef}
          type="button"
          onClick={onContinue}
          className="mt-16 min-h-[64px] w-full max-w-[300px] rounded-full bg-figma-bee px-8 text-[22px] font-semibold"
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileTap={{ scale: 0.98 }}
          transition={{ ...transition, delay: reduceMotion ? 0 : 0.32 }}
        >
          Продолжить
        </motion.button>
      </div>
    </motion.section>,
    document.body,
  );
}

function PassportForm({
  token,
  requestId,
  passport,
  onClose,
  onSaved,
}: {
  token: string;
  requestId: string;
  passport: ObjectPassport | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [connectionType, setConnectionType] = useState<string>(passport?.connectionType ?? '');
  const [difficulty, setDifficulty] = useState<string>(passport ? String(passport.difficulty) : '');
  const [equipment, setEquipment] = useState(passport?.equipment ?? '');
  const [accessNotes, setAccessNotes] = useState(passport?.accessNotes ?? '');
  const [comment, setComment] = useState(passport?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const operation = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[min(430px,calc(100vw-24px))] overflow-y-auto rounded-[20px] bg-white p-5 text-figma-ink shadow-xl backdrop:bg-black/60"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current) return;
          const parsed = passportInputSchema.safeParse({
            connectionType,
            difficulty: Number(difficulty),
            equipment,
            accessNotes,
            comment,
          });
          if (!parsed.success) {
            setError('Выберите тип подключения и сложность от 1 до 3.');
            return;
          }
          const payload = JSON.stringify(parsed.data);
          if (operation.current?.payload !== payload)
            operation.current = { payload, id: crypto.randomUUID() };
          pending.current = true;
          setBusy(true);
          setError(null);
          try {
            await savePassport(token, requestId, operation.current.id, parsed.data);
            onSaved();
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Не удалось сохранить паспорт. Повторите попытку.',
            );
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <h2 id={titleId} className="text-xl font-semibold">
          {passport ? 'Обновить паспорт объекта' : 'Паспорт объекта'}
        </h2>
        <p className="mt-2 text-sm text-figma-muted">
          Проверьте сведения о здании. За сохранение — 35 баллов.
        </p>
        {passport ? <p className="mt-2 break-words text-sm">{passport.address}</p> : null}
        <fieldset disabled={busy} className="mt-4 flex flex-col gap-4">
          <label className="text-sm font-semibold">
            Тип подключения *
            <select
              required
              value={connectionType}
              onChange={(event) => setConnectionType(event.target.value)}
              className={fieldClass}
            >
              <option value="" disabled>
                Выберите тип
              </option>
              {Object.entries(CONNECTION_TYPES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold">
            Сложность подключения *
            <select
              required
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              className={fieldClass}
            >
              <option value="" disabled>
                Выберите сложность
              </option>
              <option value="1">1 — простое</option>
              <option value="2">2 — среднее</option>
              <option value="3">3 — сложное</option>
            </select>
          </label>
          <label className="text-sm font-semibold">
            Оборудование
            <textarea
              value={equipment}
              onChange={(event) => setEquipment(event.target.value)}
              maxLength={2000}
              rows={2}
              className={fieldClass}
            />
          </label>
          <label className="text-sm font-semibold">
            Условия доступа
            <textarea
              value={accessNotes}
              onChange={(event) => setAccessNotes(event.target.value)}
              maxLength={2000}
              rows={2}
              className={fieldClass}
            />
          </label>
          <label className="text-sm font-semibold">
            Комментарий
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={2000}
              rows={2}
              className={fieldClass}
            />
          </label>
        </fieldset>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-figma-cancel">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex-1 rounded-[20px] bg-figma-track p-3 font-semibold disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-[20px] bg-figma-bee p-3 font-semibold disabled:opacity-50"
          >
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
