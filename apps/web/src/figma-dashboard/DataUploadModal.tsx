import { motion } from 'framer-motion';
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from 'react';
import { ImportCancelledError } from '../api/client';
import type {
  DataUploadFile,
  DataUploadSummary,
  ImportPreparationView,
  OfficialImportSummary,
  ReviewImportQuality,
  RoadImportSummary,
  TabularFileInput,
} from '../api/types';
import { parseDataUpload } from '../domain/dataUpload';
import { regionStyle } from '../domain/regions';
import { t } from '../i18n';
import { FIGMA_ASSETS } from './assets';
import { ImportQualityDialog } from './ImportQualityDialog';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';
import { TabularImportDialog } from './TabularImportDialog';

export const DATA_UPLOAD_TITLE = t('figma-dashboard.DataUploadModal.724b169fae');

type UploadResult = DataUploadSummary | OfficialImportSummary;
const TABULAR_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Figma MAIN upload dialog. Same parse/upload contracts as the day-page modal,
 * chrome matches the dispatcher artboard.
 */
export function DataUploadModal({
  open,
  submitting,
  token,
  readOnly,
  existingRegions,
  motionOn,
  onClose,
  onUpload,
  onImportOfficial,
  onRoadImport,
}: {
  open: boolean;
  submitting: boolean;
  token?: string | null;
  readOnly: boolean;
  existingRegions: readonly string[];
  motionOn: boolean;
  onClose: () => void;
  onUpload: (file: DataUploadFile, review?: ReviewImportQuality) => Promise<DataUploadSummary>;
  onImportOfficial: (review?: ReviewImportQuality) => Promise<OfficialImportSummary>;
  onRoadImport: (payloadBase64: string) => Promise<RoadImportSummary>;
}) {
  const inputId = useId();
  const roadInputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const roadInputRef = useRef<HTMLInputElement | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DataUploadFile[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [tabularNotices, setTabularNotices] = useState<string[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [roadFileName, setRoadFileName] = useState<string | null>(null);
  const [roadResult, setRoadResult] = useState<RoadImportSummary | null>(null);
  const [roadError, setRoadError] = useState<string | null>(null);
  const [qualityReport, setQualityReport] = useState<ImportPreparationView | null>(null);
  const [tabularSource, setTabularSource] = useState<TabularFileInput | null>(null);
  const [tabularQueue, setTabularQueue] = useState<TabularFileInput[]>([]);
  const fileReadGeneration = useRef(0);
  const qualityDecision = useRef<((accepted: boolean) => void) | null>(null);
  const reviewQuality: ReviewImportQuality = (report) =>
    new Promise((resolve) => {
      qualityDecision.current = resolve;
      setQualityReport(report);
    });
  const decideQuality = (accepted: boolean) => {
    qualityDecision.current?.(accepted);
    qualityDecision.current = null;
    setQualityReport(null);
  };

  useEffect(
    () => () => {
      qualityDecision.current?.(false);
      fileReadGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    fileReadGeneration.current += 1;
    if (!open) return;
    qualityDecision.current?.(false);
    qualityDecision.current = null;
    setQualityReport(null);
    setFileNames([]);
    setCandidates([]);
    setIssues([]);
    setTabularNotices([]);
    setResult(null);
    setSubmitError(null);
    setDragging(false);
    setRoadFileName(null);
    setRoadResult(null);
    setRoadError(null);
    setTabularSource(null);
    setTabularQueue([]);
  }, [open]);

  const readFiles = async (files: FileList | File[]) => {
    const generation = ++fileReadGeneration.current;
    setTabularNotices([]);
    const list = [...files];
    setFileNames(list.map((file) => file.name));
    setCandidates([]);
    setIssues([]);
    setResult(null);
    setSubmitError(null);
    const next: DataUploadFile[] = [];
    const nextIssues: string[] = [];
    const tabular: TabularFileInput[] = [];
    for (const file of list) {
      if (generation !== fileReadGeneration.current) return;
      const lowerName = file.name.toLowerCase();
      try {
        if (
          lowerName.endsWith('.csv') ||
          lowerName.endsWith('.tsv') ||
          lowerName.endsWith('.xlsx')
        ) {
          if (!token) {
            nextIssues.push(t('figma-dashboard.DataUploadModal.55968b2daf', { value0: file.name }));
            continue;
          }
          if (file.size > TABULAR_MAX_BYTES) {
            nextIssues.push(t('figma-dashboard.DataUploadModal.3a755dd21d', { value0: file.name }));
            continue;
          }
          tabular.push({
            fileName: file.name,
            payloadBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
          });
          continue;
        }
        if (!lowerName.endsWith('.json')) {
          nextIssues.push(t('figma-dashboard.DataUploadModal.9fc59b12be', { value0: file.name }));
          continue;
        }
        const parsed = parseDataUpload(await file.text());
        if (!parsed.ok) {
          nextIssues.push(...parsed.issues.map((issue) => `${file.name}: ${issue}`));
          continue;
        }
        const exists = existingRegions.includes(parsed.file.region);
        if (parsed.file.mode === 'new_region' && exists) {
          nextIssues.push(
            t('figma-dashboard.DataUploadModal.ab43bb18cc', {
              value0: file.name,
              value1: parsed.file.region,
            }),
          );
          continue;
        }
        if (parsed.file.mode === 'append_requests' && !exists) {
          nextIssues.push(
            t('figma-dashboard.DataUploadModal.37daa13a04', {
              value0: file.name,
              value1: parsed.file.region,
            }),
          );
          continue;
        }
        next.push(parsed.file);
      } catch {
        nextIssues.push(t('figma-dashboard.DataUploadModal.aaecf4e666', { value0: file.name }));
      }
    }
    if (generation !== fileReadGeneration.current) return;
    setIssues(nextIssues);
    setCandidates(next);
    setTabularQueue(tabular.slice(1));
    setTabularSource(tabular[0] ?? null);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) void readFiles(event.target.files);
    event.target.value = '';
  };

  const onRoadFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setRoadFileName(file.name);
    setRoadResult(null);
    setRoadError(null);
    void file
      .arrayBuffer()
      .then((bytes) => onRoadImport(bytesToBase64(new Uint8Array(bytes))))
      .then(setRoadResult)
      .catch((error: unknown) =>
        setRoadError(
          error instanceof Error ? error.message : t('figma-dashboard.DataUploadModal.903f964752'),
        ),
      );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void readFiles(event.dataTransfer.files);
  };

  const hasFiles = candidates.length > 0 && !result;
  const applyLit = hasFiles && !submitting;
  const finishTabular = (file: DataUploadFile, notices: readonly string[]) => {
    setTabularNotices((current) => [...new Set([...current, ...notices])]);
    const exists = existingRegions.includes(file.region);
    if ((file.mode === 'new_region' && exists) || (file.mode === 'append_requests' && !exists)) {
      setIssues((current) => [
        ...current,
        t('figma-dashboard.DataUploadModal.9b0965f7fa', { value0: file.region }),
      ]);
    } else {
      setCandidates((current) => [...current, file]);
    }
    const [next, ...rest] = tabularQueue;
    setTabularQueue(rest);
    setTabularSource(next ?? null);
  };
  const cancelTabular = () => {
    setTabularSource(null);
    setTabularQueue([]);
  };

  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim
        label={t('figma-dashboard.DataUploadModal.d6d1fadd2a')}
        disabled={submitting}
        onClose={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="figma-data-upload-title"
        className="relative flex w-[720px] max-h-[860px] flex-col overflow-hidden rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
        initial={motionOn ? { opacity: 0, y: 12, scale: 0.98 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={motionOn ? { opacity: 0, y: 8, scale: 0.98 } : undefined}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center justify-between">
          <h2
            id="figma-data-upload-title"
            className="figma-text figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
          >
            {DATA_UPLOAD_TITLE}
          </h2>
          <button
            type="button"
            aria-label={t('figma-dashboard.DataUploadModal.a7a4033657')}
            disabled={submitting}
            onClick={onClose}
            className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110 disabled:opacity-50"
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
            </span>
          </button>
        </div>

        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept="application/json,.json,text/csv,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
          multiple
          className="sr-only"
          onChange={onFileInput}
        />
        <input
          id={roadInputId}
          ref={roadInputRef}
          type="file"
          accept="application/json,.json,application/gzip,.gz,.gzip"
          className="sr-only"
          onChange={onRoadFileInput}
        />

        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: Drag-and-drop supplements the native file picker button immediately below. */}
        <div
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          className={`mt-[28px] flex h-[220px] flex-col items-center justify-center rounded-[20px] border border-dashed px-[24px] text-center transition-colors ${
            dragging
              ? 'border-figma-ink bg-figma-soft'
              : 'border-[rgba(39,41,48,0.22)] bg-figma-canvas'
          }`}
        >
          <p className="font-semibold text-[20px] tracking-[-0.4px] text-figma-ink">
            {t('figma-dashboard.DataUploadModal.3ab8ac8d44')}
          </p>
          {fileNames.length > 0 ? (
            <p className="mt-[10px] max-w-full truncate font-medium text-[16px] text-figma-muted">
              {fileNames.join(', ')}
            </p>
          ) : (
            <p className="mt-[8px] font-medium text-[16px] text-figma-muted">
              {t('figma-dashboard.DataUploadModal.59b948d9ed')}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-[16px] flex h-[56px] items-center justify-center self-center rounded-[20px] border border-figma-ink/15 bg-white px-[28px] transition-transform duration-150 hover:scale-[1.01]"
        >
          <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.4px] text-figma-ink">
            {t('figma-dashboard.DataUploadModal.85d1a8e468')}
          </span>
        </button>

        <div className="mt-[16px] flex items-center justify-between gap-[16px] rounded-[20px] bg-figma-soft px-[20px] py-[14px]">
          <div className="min-w-0">
            <p className="font-semibold text-[16px] text-figma-ink">
              {t('figma-dashboard.DataUploadModal.3f9e3f4786')}
            </p>
            <p className="mt-[3px] truncate font-medium text-[14px] text-figma-muted">
              {roadFileName ?? t('figma-dashboard.DataUploadModal.ed773db828')}
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={() => roadInputRef.current?.click()}
            className="flex h-[44px] shrink-0 items-center justify-center rounded-[14px] border border-figma-ink/15 bg-white px-[16px] font-semibold text-[15px] text-figma-ink transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
          >
            {t('figma-dashboard.DataUploadModal.848ed36881')}
          </button>
        </div>

        {roadError ? (
          <div role="alert" className="mt-[10px] rounded-[16px] bg-[#fdecec] px-[16px] py-[10px]">
            <p className="font-medium text-[14px] text-figma-danger">{roadError}</p>
          </div>
        ) : null}
        {roadResult ? (
          <div role="status" className="mt-[10px] rounded-[16px] bg-figma-soft px-[16px] py-[10px]">
            <p className="font-semibold text-[14px] text-figma-ink">
              {roadResult.status === 'replayed'
                ? t('figma-dashboard.DataUploadModal.331258919c')
                : t('figma-dashboard.DataUploadModal.a1dc7d1734')}
            </p>
            <p className="mt-[3px] font-medium text-[13px] text-figma-muted">
              {roadResult.nodes}
              {t('figma-dashboard.DataUploadModal.6c7a64aeae')}
              {roadResult.edges}
              {t('figma-dashboard.DataUploadModal.9d0dd392f8')}
            </p>
          </div>
        ) : null}

        <div className="mt-[16px] min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
          {tabularNotices.length > 0 ? (
            <details className="rounded-[16px] bg-figma-soft p-[16px] text-[14px]">
              <summary>
                {t('figma-dashboard.DataUploadModal.1fbd1d2099')}
                {tabularNotices.length}
              </summary>
              <ul className="mt-[8px] list-disc pl-[18px]">
                {tabularNotices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {issues.length > 0 ? (
            <div role="alert" className="rounded-[20px] bg-[#fdecec] px-[20px] py-[16px]">
              <p className="font-semibold text-[18px] text-figma-danger">
                {t('figma-dashboard.DataUploadModal.bea3eed275')}
              </p>
              <ul className="mt-[8px] list-disc space-y-[4px] pl-[20px] font-medium text-[15px] text-figma-ink">
                {issues.slice(0, 8).map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {candidates.length > 0 ? (
            <div className="mt-[12px] space-y-[10px]">
              {candidates.map((file) => (
                <UploadPreview key={`${file.region}:${file.sourceVersion}`} file={file} />
              ))}
            </div>
          ) : null}

          {submitError ? (
            <div role="alert" className="mt-[12px] rounded-[20px] bg-[#fdecec] px-[20px] py-[16px]">
              <p className="font-semibold text-[18px] text-figma-danger">
                {t('figma-dashboard.DataUploadModal.1fa91d5a4b')}
              </p>
              <p className="mt-[6px] font-medium text-[15px] text-figma-ink">{submitError}</p>
            </div>
          ) : null}

          {result ? (
            <div
              role="status"
              className="mt-[12px] rounded-[20px] bg-figma-soft px-[20px] py-[16px]"
            >
              <p className="font-semibold text-[18px] text-figma-ink">
                {result.applied
                  ? t('figma-dashboard.DataUploadModal.bffb0c00bd')
                  : t('figma-dashboard.DataUploadModal.5c4f0dfc69')}
              </p>
              <p className="mt-[6px] font-medium text-[15px] text-figma-muted">
                {t('figma-dashboard.DataUploadModal.106eb83f8f')}
                {result.requestsCreated}
                {t('figma-dashboard.DataUploadModal.5b622a13c6')}
                {result.engineersCreated}
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-[20px] flex items-center justify-between gap-[16px]">
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              if (readOnly) {
                setSubmitError(t('figma-dashboard.DataUploadModal.5e8b1dd7bc'));
                return;
              }
              setSubmitError(null);
              setCandidates([]);
              setIssues([]);
              void onImportOfficial(reviewQuality)
                .then(setResult)
                .catch((error: unknown) =>
                  setSubmitError(
                    error instanceof ImportCancelledError
                      ? null
                      : error instanceof Error
                        ? error.message
                        : t('figma-dashboard.DataUploadModal.bbc31f0cba'),
                  ),
                );
            }}
            className="flex h-[56px] items-center justify-center rounded-[20px] bg-figma-bee px-[24px] transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
          >
            <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.4px] text-figma-ink">
              {t('figma-dashboard.DataUploadModal.6b7c20f521')}
            </span>
          </button>
          <div className="flex items-center gap-[10px]">
            <GhostButton disabled={submitting} onClick={onClose}>
              {t('figma-dashboard.DataUploadModal.8fbe9b75cb')}
            </GhostButton>
            <button
              type="button"
              disabled={!applyLit}
              onClick={() => {
                if (!applyLit) return;
                if (readOnly) {
                  setSubmitError(t('figma-dashboard.DataUploadModal.5e8b1dd7bc'));
                  return;
                }
                setSubmitError(null);
                void (async () => {
                  try {
                    let last: UploadResult | null = null;
                    for (const file of candidates) {
                      last = await onUpload(file, reviewQuality);
                    }
                    setResult(last);
                    setCandidates([]);
                  } catch (error: unknown) {
                    setSubmitError(
                      error instanceof ImportCancelledError
                        ? null
                        : error instanceof Error
                          ? error.message
                          : t('figma-dashboard.DataUploadModal.5b0e622ef9'),
                    );
                  }
                })();
              }}
              className={`flex h-[56px] items-center justify-center rounded-[20px] px-[28px] transition-transform duration-150 ${
                applyLit ? 'bg-figma-bee hover:scale-[1.01]' : 'bg-figma-track text-figma-hint'
              } disabled:opacity-100`}
            >
              <span
                className={`figma-nowrap font-semibold text-[18px] tracking-[-0.4px] ${
                  applyLit ? 'text-figma-ink' : 'text-figma-hint'
                }`}
              >
                {submitting
                  ? t('figma-dashboard.DataUploadModal.22a5d91124')
                  : t('figma-dashboard.DataUploadModal.e15f960d93')}
              </span>
            </button>
          </div>
        </div>
      </motion.div>
      {qualityReport ? (
        <ImportQualityDialog
          report={qualityReport}
          motionOn={motionOn}
          onDecision={decideQuality}
        />
      ) : null}
      {tabularSource && token ? (
        <TabularImportDialog
          key={`${tabularSource.fileName}:${tabularQueue.length}`}
          token={token}
          source={tabularSource}
          existingRegions={existingRegions}
          motionOn={motionOn}
          onBack={cancelTabular}
          onComplete={finishTabular}
        />
      ) : null}
    </ModalLayer>
  );
}

function GhostButton({
  children,
  disabled,
  onClick,
}: {
  children: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-[56px] items-center justify-center rounded-[20px] border border-[rgba(39,41,48,0.14)] bg-white px-[24px] transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
    >
      <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.4px] text-figma-ink">
        {children}
      </span>
    </button>
  );
}

function UploadPreview({ file }: { file: DataUploadFile }) {
  const style = regionStyle(file.region);
  return (
    <div className="rounded-[20px] bg-figma-soft px-[20px] py-[16px]">
      <p className="font-semibold text-[18px] text-figma-ink">{style.label}</p>
      <p className="mt-[6px] font-medium text-[15px] text-figma-muted">
        {file.mode === 'new_region'
          ? t('figma-dashboard.DataUploadModal.6ee32b0951')
          : t('figma-dashboard.DataUploadModal.0207074be4')}{' '}
        · {file.requests.length}
        {t('figma-dashboard.DataUploadModal.a7b7ba4108')}
      </p>
    </div>
  );
}

/** Encodes raw JSON or gzip bytes without UTF-8 decoding or adding envelope fields. */
function bytesToBase64(bytes: Uint8Array): string {
  let encoded = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(encoded);
}
