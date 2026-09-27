import { t } from '../i18n';
import { ModalLayer, ModalScrim } from './modalLayer';

/** Explains the AI interview before navigating to the dispatcher's existing conversation. */
export function PersonalPolicyDialog({
  open,
  motionOn,
  onClose,
  onContinue,
  disabled = false,
}: {
  open: boolean;
  motionOn: boolean;
  onClose: () => void;
  onContinue: () => void;
  disabled?: boolean;
}) {
  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label={t('figma-dashboard.PersonalPolicyDialog.053ef87787')} onClose={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="personal-policy-title"
        className="relative w-[640px] rounded-[24px] bg-white p-[32px] text-figma-ink"
      >
        <h2 id="personal-policy-title" className="text-[28px] font-bold">
          {t('figma-dashboard.PersonalPolicyDialog.614f02c437')}
        </h2>
        <p className="mt-[20px] text-[20px] leading-relaxed">
          {t('figma-dashboard.PersonalPolicyDialog.98a17f1672')}
        </p>
        <p className="mt-[12px] text-[16px] text-figma-ink/65">
          {t('figma-dashboard.PersonalPolicyDialog.c7cd0c77e2')}
        </p>
        <div className="mt-[28px] flex justify-end gap-[16px]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[16px] border border-figma-ink/25 px-[24px] py-[14px] text-[18px]"
          >
            {t('figma-dashboard.PersonalPolicyDialog.8fbe9b75cb')}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onContinue}
            title={disabled ? t('common.offlineContour') : undefined}
            className="client-ai-fill rounded-[16px] px-[24px] py-[14px] text-[18px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('figma-dashboard.PersonalPolicyDialog.b8f392228a')}
          </button>
        </div>
      </section>
    </ModalLayer>
  );
}
