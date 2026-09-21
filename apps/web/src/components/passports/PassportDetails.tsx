import { CONNECTION_TYPES, type ObjectPassport, type PassportAudience } from '../../api/passports';
import { usePassport } from './usePassport';

/** Read-only building facts shared by all visits, including future route stops. */
export function PassportDetails({ passport }: { passport: ObjectPassport }) {
  return (
    <section
      aria-label="Паспорт объекта"
      className="shrink-0 rounded-[20px] bg-figma-ink p-5 text-white"
    >
      <h2 className="font-semibold text-lg">Паспорт объекта</h2>
      <p className="mt-1 break-words text-sm text-white/70">{passport.address}</p>
      <p className={`mt-2 text-sm ${passport.stale ? 'text-figma-cancel' : 'text-white/70'}`}>
        Заполнен{' '}
        {new Date(passport.updatedAt * 1000).toLocaleDateString('ru-RU', {
          timeZone: 'Europe/Moscow',
        })}
        {passport.stale ? ' · устарел' : ''}
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <Fact label="Тип подключения" value={CONNECTION_TYPES[passport.connectionType]} />
        <Fact label="Сложность подключения" value={`${passport.difficulty} из 3`} />
        {passport.equipment ? <Fact label="Оборудование" value={passport.equipment} /> : null}
        {passport.accessNotes ? (
          <Fact label="Условия доступа" value={passport.accessNotes} />
        ) : null}
        {passport.comment ? <Fact label="Комментарий" value={passport.comment} /> : null}
      </dl>
    </section>
  );
}

/** Loads a passport only for an authenticated real request; missing passports stay unobtrusive. */
export function RequestPassport({
  token,
  audience,
  requestId,
}: {
  token: string;
  audience: PassportAudience;
  requestId: string;
}) {
  const { data, error, refresh } = usePassport(token, audience, requestId);
  if (error)
    return (
      <div className="rounded-[20px] bg-figma-track p-4 text-sm text-figma-ink">
        <p>{error}</p>
        <button type="button" onClick={refresh} className="mt-2 font-semibold underline">
          Повторить
        </button>
      </div>
    );
  if (!data)
    return (
      <p className="p-4 text-sm text-figma-muted" role="status">
        Загружаем паспорт…
      </p>
    );
  return data.passport ? <PassportDetails passport={data.passport} /> : null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-white/60">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}
