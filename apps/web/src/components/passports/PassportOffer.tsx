import { useEffect, useId, useRef, useState } from 'react';
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
  const [saved, setSaved] = useState(false);
  if (error)
    return (
      <div className="mt-3 text-sm text-figma-muted">
        <span>{error}. </span>
        <button type="button" onClick={refresh} className="underline">
          Повторить
        </button>
      </div>
    );
  if (saved)
    return (
      <p className="mt-3 text-sm font-semibold text-figma-ink" role="status">
        Паспорт сохранён · +35 баллов
      </p>
    );
  if (!data?.canFill) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 flex w-full items-center justify-between gap-3 rounded-[20px] bg-figma-bee p-4 text-left font-semibold text-figma-ink"
      >
        <span>{data.passport ? 'Обновить паспорт' : 'Заполнить паспорт'}</span>
        <span className="shrink-0 text-sm">+35 баллов</span>
      </button>
      {open ? (
        <PassportForm
          token={token}
          requestId={requestId}
          passport={data.passport}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setSaved(true);
            announcePassportSaved();
            refresh();
          }}
        />
      ) : null}
    </>
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
