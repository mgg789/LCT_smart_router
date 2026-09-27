import { t } from '../i18n';
/**
 * Error banner for the engineer and client phone column.
 *
 * The dispatcher card is 425px and pinned to the browser edge. On a 430px phone
 * that card starts off the left side of the screen and is not centered.
 */
export function PhoneErrorNotice({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-4">
      <article
        role="alert"
        className="pointer-events-auto w-full max-w-[22rem] rounded-2xl bg-figma-danger px-4 py-3 text-white shadow-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="font-semibold text-[16px] leading-5">{title}</p>
          <button
            type="button"
            aria-label={t('figma-engineer.PhoneErrorNotice.1907d5c300')}
            className="shrink-0 text-[20px] leading-none text-white"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-[14px] leading-5">{body}</p>
      </article>
    </div>
  );
}
