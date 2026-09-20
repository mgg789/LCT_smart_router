import type { ReactNode } from 'react';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

/**
 * Shared Figma ALERTS action (49:5702 / 49:5704). Geometry stays the same;
 * only fill and border change per variant.
 */
export function InboxButton({
  variant,
  children,
  onClick,
}: {
  variant: 'bee' | 'outline' | 'ink';
  children: ReactNode;
  onClick?: () => void;
}) {
  const tone =
    variant === 'bee'
      ? 'bg-figma-bee text-figma-ink hover:brightness-105'
      : variant === 'outline'
        ? 'border border-figma-ink bg-white text-figma-ink hover:bg-figma-soft'
        : 'border border-white bg-figma-ink text-white hover:brightness-125';
  return (
    <button
      type="button"
      className={`flex items-center justify-center overflow-clip rounded-[20px] px-[32px] py-[16px] font-semibold text-[20px] tracking-[-0.6px] transition duration-300 ease-out hover:scale-[1.02] active:scale-[0.97] ${tone}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Figma 49:5696 shell: 211px white card, title + optional name + tip, reason, actions.
 */
export function InboxAlertCardView({
  title,
  engineerName,
  badge,
  body,
  primaryLabel,
  secondaryLabel,
  onPrimary,
}: {
  title: string;
  engineerName: string | null;
  badge: string | null;
  body: string;
  primaryLabel: string | null;
  secondaryLabel: string | null;
  onPrimary?: () => void;
}) {
  return (
    <article className="flex h-[211px] w-full flex-col overflow-clip rounded-[20px] bg-white px-[30px] pt-[19px] pb-[24px]">
      <InboxCardHeader
        title={title}
        engineerName={engineerName}
        afterTitle={
          badge ? (
            <span className="inline-flex h-[42px] items-center rounded-full bg-figma-track px-[20px] font-medium text-[20px] tracking-[-0.34px] text-figma-ink">
              {badge}
            </span>
          ) : null
        }
        titleClass="text-black"
      />
      <p className="mt-[16px] max-w-[1234px] font-semibold text-[20px] tracking-[-0.34px] text-figma-muted">
        {body}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-[20px]">
        {primaryLabel ? (
          <InboxButton variant="bee" onClick={onPrimary}>
            {primaryLabel}
          </InboxButton>
        ) : null}
        {secondaryLabel ? <InboxButton variant="outline">{secondaryLabel}</InboxButton> : null}
        <InboxAiLink tone="ink" />
      </div>
    </article>
  );
}

/**
 * Same 49:5696 shell as the alert: icon instead of the tip, dark ink fill, one Hide button.
 */
export function InboxNoticeCardView({
  title,
  body,
  icon,
  onHide,
}: {
  title: string;
  body: string;
  icon: { src: string; width: number; height: number };
  onHide: () => void;
}) {
  return (
    <article className="flex h-[211px] w-full flex-col overflow-clip rounded-[20px] bg-figma-ink px-[30px] pt-[19px] pb-[24px]">
      <InboxCardHeader
        title={title}
        engineerName={null}
        afterTitle={
          <span className="flex size-[36px] items-center justify-center">
            <FigmaIcon
              src={icon.src}
              alt=""
              width={icon.width}
              height={icon.height}
              className={icon.src.endsWith('.png') ? undefined : 'brightness-0 invert'}
            />
          </span>
        }
        titleClass="text-white"
      />
      <p className="mt-[16px] max-w-[1234px] font-semibold text-[20px] tracking-[-0.34px] text-white">
        {body}
      </p>
      <div className="mt-auto flex items-center gap-[20px]">
        <InboxButton variant="ink" onClick={onHide}>
          Скрыть
        </InboxButton>
      </div>
    </article>
  );
}

/** Display-level normalization: card titles always open with a capital letter. */
function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function InboxCardHeader({
  title,
  engineerName,
  afterTitle,
  titleClass,
}: {
  title: string;
  engineerName: string | null;
  afterTitle: ReactNode;
  titleClass: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-[16px]">
      <p className={`font-bold text-[24px] leading-none ${titleClass}`}>{capitalizeFirst(title)}</p>
      {engineerName ? (
        <>
          <span
            className={`size-[5px] rounded-full ${titleClass === 'text-white' ? 'bg-white' : 'bg-figma-ink'}`}
            aria-hidden
          />
          <p className={`font-bold text-[24px] leading-none ${titleClass}`}>{engineerName}</p>
        </>
      ) : null}
      {afterTitle}
    </div>
  );
}

function InboxAiLink({ tone }: { tone: 'ink' | 'white' }) {
  return (
    <button
      type="button"
      disabled
      aria-disabled
      title="Скоро"
      className={`flex cursor-not-allowed items-center gap-[8px] font-semibold text-[18px] tracking-[-0.54px] opacity-45 ${
        tone === 'white' ? 'text-white' : 'text-figma-ink'
      }`}
    >
      Разобрать в AI
      <FigmaIcon
        src={FIGMA_ASSETS.iconArrowCircle}
        alt=""
        width={22}
        height={22}
        className={tone === 'white' ? 'brightness-0 invert' : undefined}
      />
    </button>
  );
}
