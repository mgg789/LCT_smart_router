import { ModalLayer, ModalScrim } from './modalLayer';

/** Explains the AI interview before navigating to the dispatcher's existing conversation. */
export function PersonalPolicyDialog({
  open,
  motionOn,
  onClose,
  onContinue,
}: {
  open: boolean;
  motionOn: boolean;
  onClose: () => void;
  onContinue: () => void;
}) {
  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label="Закрыть настройку личной политики" onClose={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="personal-policy-title"
        className="relative w-[640px] rounded-[24px] bg-white p-[32px] text-figma-ink"
      >
        <h2 id="personal-policy-title" className="text-[28px] font-bold">
          Задайте свою политику
        </h2>
        <p className="mt-[20px] text-[20px] leading-relaxed">
          Расскажите ассистенту, что для вас важно. Он уточнит приоритеты и создаст вашу личную
          политику. Если она уже настроена, вы сможете изменить её параметры.
        </p>
        <p className="mt-[12px] text-[16px] text-figma-ink/65">
          После сохранения выберите политику в списке. Навыки, безопасность и обязательные
          ограничения сохраняются.
        </p>
        <div className="mt-[28px] flex justify-end gap-[16px]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[16px] border border-figma-ink/25 px-[24px] py-[14px] text-[18px]"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="client-ai-fill rounded-[16px] px-[24px] py-[14px] text-[18px] font-semibold text-white"
          >
            Перейти в AI
          </button>
        </div>
      </section>
    </ModalLayer>
  );
}
