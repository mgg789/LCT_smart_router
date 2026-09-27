import { CONNECTION_TYPES, type ObjectPassport, type PassportAudience } from '../../api/passports';
import { locale, t } from '../../i18n';
import { usePassport } from './usePassport';

/** Read-only building facts shared by all visits, including future route stops. */
export function PassportDetails({
  passport,
  surface = 'engineer',
}: {
  passport: ObjectPassport;
  surface?: PassportAudience;
}) {
  const dispatcher = surface === 'dispatch';
  return (
    <section
      aria-label={t('components.passports.PassportDetails.5e289abfb8')}
      className={`shrink-0 rounded-[20px] p-5 text-white ${dispatcher ? 'bg-white/10' : 'bg-figma-ink'}`}
    >
      <h2 className="font-semibold text-lg">
        {t('components.passports.PassportDetails.5e289abfb8')}
      </h2>
      <p className="mt-1 break-words text-sm text-white/70">{passport.address}</p>
      <p className={`mt-2 text-sm ${passport.stale ? 'text-figma-cancel' : 'text-white/70'}`}>
        {t('components.passports.PassportDetails.d4fe6957b1')}{' '}
        {new Date(passport.updatedAt * 1000).toLocaleDateString(locale, {
          timeZone: 'Europe/Moscow',
        })}
        {passport.stale ? t('components.passports.PassportDetails.55c9f4e552') : ''}
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <Fact
          label={t('components.passports.PassportDetails.b093c16936')}
          value={CONNECTION_TYPES[passport.connectionType]}
        />
        <Fact
          label={t('components.passports.PassportDetails.5a98f05a25')}
          value={t('components.passports.PassportDetails.a7219c1072', {
            value0: passport.difficulty,
          })}
        />
        {passport.equipment ? (
          <Fact
            label={t('components.passports.PassportDetails.7f1b1af539')}
            value={passport.equipment}
          />
        ) : null}
        {passport.accessNotes ? (
          <Fact
            label={t('components.passports.PassportDetails.e3e7dd800e')}
            value={passport.accessNotes}
          />
        ) : null}
        {passport.comment ? (
          <Fact
            label={t('components.passports.PassportDetails.d89b310286')}
            value={passport.comment}
          />
        ) : null}
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
          {t('components.passports.PassportDetails.5189135a61')}
        </button>
      </div>
    );
  if (!data)
    return (
      <p className="p-4 text-sm text-figma-muted" role="status">
        {t('components.passports.PassportDetails.401758aaf9')}
      </p>
    );
  return data.passport ? <PassportDetails passport={data.passport} surface={audience} /> : null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-white/60">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}
