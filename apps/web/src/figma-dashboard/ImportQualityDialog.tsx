import { motion } from 'framer-motion';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ImportPreparationView } from '../api/types';

/** Mandatory import review above the upload dialog; only an explicit decision dismisses it. */
export function ImportQualityDialog({
  report,
  motionOn,
  onDecision,
}: {
  report: ImportPreparationView;
  motionOn: boolean;
  onDecision: (accepted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const findings = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    heading.current?.focus({ preventScroll: true });
    if (findings.current) findings.current.scrollTop = 0;
    return () => node?.close();
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => event.preventDefault()}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[min(94vw,860px)] max-w-none overflow-hidden rounded-[20px] border-0 bg-white p-0 text-figma-ink backdrop:bg-figma-ink/40"
    >
      <motion.div
        initial={motionOn ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex max-h-[90dvh] flex-col"
      >
        <div className="shrink-0 px-[24px] pt-[24px]">
          <h2 ref={heading} tabIndex={-1} id={titleId} className="font-extrabold text-[24px]">
            Проверка данных: {report.findings.length} находок
          </h2>
          <p className="mt-[8px] text-[16px] text-figma-muted">
            Проверьте особенности данных. «Загрузить так» импортирует пакет без изменений.
            «Продолжить» вернёт к выбору данных без импорта.
          </p>
        </div>
        <div ref={findings} className="min-h-0 overflow-y-auto px-[24px] py-[20px]">
          <ul className="space-y-[16px] text-[16px]">
            {report.findings.map((finding) => (
              <li key={`${finding.layer}:${finding.code}`}>
                <p>
                  {finding.message} · {finding.count}
                </p>
                <p className="mt-[4px] text-figma-muted">Примеры: {finding.examples.join(', ')}</p>
              </li>
            ))}
          </ul>
          <details className="mt-[16px] text-[13px] text-figma-muted">
            <summary>Данные проверки</summary>
            <p>Версии: {Object.values(report.versions).join(' · ')}</p>
            {report.findings.map((finding) => (
              <p key={`${finding.layer}:${finding.code}`}>
                {finding.code}: {finding.layer}
                {finding.score === undefined ? '' : ` · ${finding.score.toFixed(3)}`}
              </p>
            ))}
          </details>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-[12px] border-t border-figma-track p-[24px]">
          <button
            type="button"
            onClick={() => onDecision(false)}
            className="rounded-[20px] bg-figma-track px-[24px] py-[16px] font-semibold text-[16px]"
          >
            Продолжить
          </button>
          <button
            type="button"
            onClick={() => onDecision(true)}
            className="rounded-[20px] bg-figma-bee px-[24px] py-[16px] font-semibold text-[16px]"
          >
            Загрузить так
          </button>
        </div>
      </motion.div>
    </dialog>,
    document.body,
  );
}
