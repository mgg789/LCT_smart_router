import { motion } from 'framer-motion';
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from 'react';
import type { DataUploadFile, DataUploadSummary, OfficialImportSummary } from '../api/types';
import { parseDataUpload } from '../domain/dataUpload';
import { regionStyle } from '../domain/regions';
import { FIGMA_ASSETS } from './assets';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';

export const DATA_UPLOAD_TITLE = 'Загрузить данные';

type UploadResult = DataUploadSummary | OfficialImportSummary;

/**
 * Figma MAIN upload dialog. Same parse/upload contracts as the day-page modal,
 * chrome matches the dispatcher artboard.
 */
export function DataUploadModal({
  open,
  submitting,
  readOnly,
  existingRegions,
  motionOn,
  onClose,
  onUpload,
  onImportOfficial,
}: {
  open: boolean;
  submitting: boolean;
  readOnly: boolean;
  existingRegions: readonly string[];
  motionOn: boolean;
  onClose: () => void;
  onUpload: (file: DataUploadFile) => Promise<DataUploadSummary>;
  onImportOfficial: () => Promise<OfficialImportSummary>;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DataUploadFile[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFileNames([]);
    setCandidates([]);
    setIssues([]);
    setResult(null);
    setSubmitError(null);
    setDragging(false);
  }, [open]);

  const readFiles = async (files: FileList | File[]) => {
    const list = [...files];
    setFileNames(list.map((file) => file.name));
    setCandidates([]);
    setIssues([]);
    setResult(null);
    setSubmitError(null);
    const next: DataUploadFile[] = [];
    const nextIssues: string[] = [];
    for (const file of list) {
      if (!file.name.toLowerCase().endsWith('.json')) {
        nextIssues.push(`${file.name}: выберите файл с расширением .json.`);
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
          `${file.name}: регион ${parsed.file.region} уже существует. Используйте mode: "append_requests".`,
        );
        continue;
      }
      if (parsed.file.mode === 'append_requests' && !exists) {
        nextIssues.push(
          `${file.name}: регион ${parsed.file.region} ещё не загружен. Используйте mode: "new_region".`,
        );
        continue;
      }
      next.push(parsed.file);
    }
    setIssues(nextIssues);
    setCandidates(next);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) void readFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void readFiles(event.dataTransfer.files);
  };

  const hasFiles = candidates.length > 0 && !result;
  const applyLit = hasFiles && !submitting;

  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label="Закрыть загрузку данных" disabled={submitting} onClose={onClose} />
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
            aria-label="Закрыть"
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
          accept="application/json,.json"
          multiple
          className="sr-only"
          onChange={onFileInput}
        />

        {/* biome-ignore lint/a11y/noStaticElementInteractions: Drag-and-drop supplements the native file picker button immediately below. */}
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
            Перетащите JSON сюда
          </p>
          {fileNames.length > 0 ? (
            <p className="mt-[10px] max-w-full truncate font-medium text-[16px] text-figma-muted">
              {fileNames.join(', ')}
            </p>
          ) : (
            <p className="mt-[8px] font-medium text-[16px] text-figma-muted">
              Один файл или несколько
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-[16px] flex h-[56px] items-center justify-center self-center rounded-[20px] border border-figma-ink/15 bg-white px-[28px] transition-transform duration-150 hover:scale-[1.01]"
        >
          <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.4px] text-figma-ink">
            Выбрать из файлов
          </span>
        </button>

        <div className="mt-[16px] min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
          {issues.length > 0 ? (
            <div role="alert" className="rounded-[20px] bg-[#fdecec] px-[20px] py-[16px]">
              <p className="font-semibold text-[18px] text-figma-danger">Файл не прошёл проверку</p>
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
              <p className="font-semibold text-[18px] text-figma-danger">Сервер отклонил пакет</p>
              <p className="mt-[6px] font-medium text-[15px] text-figma-ink">{submitError}</p>
            </div>
          ) : null}

          {result ? (
            <div
              role="status"
              className="mt-[12px] rounded-[20px] bg-figma-soft px-[20px] py-[16px]"
            >
              <p className="font-semibold text-[18px] text-figma-ink">
                {result.applied ? 'Данные загружены' : 'Этот пакет уже был загружен'}
              </p>
              <p className="mt-[6px] font-medium text-[15px] text-figma-muted">
                Заявки: +{result.requestsCreated}, инженеры: +{result.engineersCreated}
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
                setSubmitError('Загрузка доступна в живом контуре после входа.');
                return;
              }
              setSubmitError(null);
              setCandidates([]);
              setIssues([]);
              void onImportOfficial()
                .then(setResult)
                .catch((error: unknown) =>
                  setSubmitError(
                    error instanceof Error ? error.message : 'Не удалось загрузить сет из ТЗ',
                  ),
                );
            }}
            className="flex h-[56px] items-center justify-center rounded-[20px] bg-figma-bee px-[24px] transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
          >
            <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.4px] text-figma-ink">
              Использовать сет из ТЗ
            </span>
          </button>
          <div className="flex items-center gap-[10px]">
            <GhostButton disabled={submitting} onClick={onClose}>
              Отмена
            </GhostButton>
            <button
              type="button"
              disabled={!applyLit}
              onClick={() => {
                if (!applyLit) return;
                if (readOnly) {
                  setSubmitError('Загрузка доступна в живом контуре после входа.');
                  return;
                }
                setSubmitError(null);
                void (async () => {
                  try {
                    let last: UploadResult | null = null;
                    for (const file of candidates) {
                      last = await onUpload(file);
                    }
                    setResult(last);
                    setCandidates([]);
                  } catch (error: unknown) {
                    setSubmitError(
                      error instanceof Error ? error.message : 'Не удалось загрузить пакет',
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
                {submitting ? 'Загружаем…' : 'Применить'}
              </span>
            </button>
          </div>
        </div>
      </motion.div>
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
        {file.mode === 'new_region' ? 'Новый регион' : 'Дополнительные заявки'} ·{' '}
        {file.requests.length} заявок
      </p>
    </div>
  );
}
