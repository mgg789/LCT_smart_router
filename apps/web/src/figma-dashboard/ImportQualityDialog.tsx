import { motion } from 'framer-motion';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ImportPreparationView } from '../api/types';
import { t } from '../i18n';

/**
 * One example as the dispatcher knows it: the request number from the package.
 *
 * The checker keys its examples by `<регион>:<номер>` so they stay unique across a
 * multi-region import, but the region prefix is an internal code — «southeast:32589»
 * on screen told the dispatcher nothing they could look the request up by.
 */
export function exampleLabel(example: string): string {
  const number = example.slice(example.lastIndexOf(':') + 1).trim();
  return number.length > 0 ? `№ ${number}` : example;
}

/** Label for leaving the import review and returning to the upload form. */
export const IMPORT_QUALITY_BACK_LABEL = t('figma-dashboard.ImportQualityDialog.6c99e7d8fb');
/** Label for accepting the reviewed package without changing its contents. */
export const IMPORT_QUALITY_ACCEPT_LABEL = t('figma-dashboard.ImportQualityDialog.2027efe636');

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
            {t('figma-dashboard.ImportQualityDialog.e0e979d5d9')}
            {report.findings.length}
            {t('figma-dashboard.ImportQualityDialog.3e4e727812')}
          </h2>
          <p className="mt-[8px] text-[16px] text-figma-muted">
            {t('figma-dashboard.ImportQualityDialog.2820d317a2')}
          </p>
        </div>
        <div ref={findings} className="min-h-0 overflow-y-auto px-[24px] py-[20px]">
          <ul className="space-y-[16px] text-[16px]">
            {report.findings.map((finding) => (
              <li key={`${finding.layer}:${finding.code}`}>
                <p>
                  {finding.message} · {finding.count}
                </p>
                <p className="mt-[4px] text-figma-muted">
                  {t('figma-dashboard.ImportQualityDialog.b16740dc0a')}
                  {finding.examples.map(exampleLabel).join(', ')}
                </p>
              </li>
            ))}
          </ul>
          <details className="mt-[16px] text-[13px] text-figma-muted">
            <summary>{t('figma-dashboard.ImportQualityDialog.0df1861f79')}</summary>
            <p>
              {t('figma-dashboard.ImportQualityDialog.2b23586499')}
              {Object.values(report.versions).join(' · ')}
            </p>
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
            {IMPORT_QUALITY_BACK_LABEL}
          </button>
          <button
            type="button"
            onClick={() => onDecision(true)}
            className="rounded-[20px] bg-figma-bee px-[24px] py-[16px] font-semibold text-[16px]"
          >
            {IMPORT_QUALITY_ACCEPT_LABEL}
          </button>
        </div>
      </motion.div>
    </dialog>,
    document.body,
  );
}
