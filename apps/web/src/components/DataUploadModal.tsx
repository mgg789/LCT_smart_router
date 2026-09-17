import { Database, FileJson, Upload, X } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useEffect, useState } from 'react';
import type { DataUploadFile, DataUploadSummary, OfficialImportSummary } from '../api/types';
import { parseDataUpload } from '../domain/dataUpload';
import { regionStyle } from '../domain/regions';

interface DataUploadModalProps {
  readonly open: boolean;
  readonly submitting: boolean;
  readonly existingRegions: readonly string[];
  readonly onClose: () => void;
  readonly onUpload: (file: DataUploadFile) => Promise<DataUploadSummary>;
  readonly onImportOfficial: () => Promise<OfficialImportSummary>;
}

/** Validates and previews a region package before sending it to the backend atomically. */
export function DataUploadModal({
  open,
  submitting,
  existingRegions,
  onClose,
  onUpload,
  onImportOfficial,
}: DataUploadModalProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<DataUploadFile | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<DataUploadSummary | OfficialImportSummary | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFileName(null);
    setCandidate(null);
    setIssues([]);
    setResult(null);
    setSubmitError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, submitting]);

  if (!open) return null;

  const readFile = async (file: File) => {
    setFileName(file.name);
    setCandidate(null);
    setIssues([]);
    setResult(null);
    setSubmitError(null);
    if (!file.name.toLowerCase().endsWith('.json')) {
      setIssues(['Выберите файл с расширением .json.']);
      return;
    }
    const parsed = parseDataUpload(await file.text());
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    const exists = existingRegions.includes(parsed.file.region);
    if (parsed.file.mode === 'new_region' && exists) {
      setIssues([
        `Регион ${parsed.file.region} уже существует. Используйте mode: "append_requests".`,
      ]);
      return;
    }
    if (parsed.file.mode === 'append_requests' && !exists) {
      setIssues([`Регион ${parsed.file.region} ещё не загружен. Используйте mode: "new_region".`]);
      return;
    }
    setCandidate(parsed.file);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-ink/45"
        aria-label="Закрыть загрузку данных"
        disabled={submitting}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-upload-title"
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="data-upload-title" className="text-xl font-semibold">
              Загрузить данные
            </h2>
            <p className="mt-1 text-sm text-muted">
              Официальный датасет из ТЗ подгружается из репозитория одной кнопкой. Свой JSON сначала
              проверяется в браузере.
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            disabled={submitting}
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-canvas disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            setSubmitError(null);
            setCandidate(null);
            setIssues([]);
            void onImportOfficial()
              .then(setResult)
              .catch((error: unknown) =>
                setSubmitError(
                  error instanceof Error ? error.message : 'Не удалось загрузить датасет из ТЗ',
                ),
              );
          }}
          className="mt-5 flex w-full flex-col items-start rounded-2xl border border-bee bg-bee/15 px-4 py-4 text-left disabled:opacity-50"
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4" />
            Использовать датасет из ТЗ
          </span>
          <span className="mt-1 text-[13px] text-muted">
            Три региона организаторов из репозитория: 205 заявок и 35 инженеров. План пересчитается
            после загрузки.
          </span>
        </button>

        <input
          id="data-upload-file"
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={onFileInput}
        />
        <label
          htmlFor="data-upload-file"
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          className={`mt-5 rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
            dragging ? 'border-ink bg-canvas' : 'border-line'
          }`}
        >
          <FileJson className="mx-auto h-9 w-9 text-muted" strokeWidth={1.5} />
          <p className="mt-3 text-sm font-medium">Перетащите JSON сюда</p>
          <p className="mt-1 text-[13px] text-muted">или выберите файл на компьютере</p>
          <span className="mt-4 inline-block rounded-full border border-line px-4 py-2 text-sm font-medium">
            Выбрать файл
          </span>
          {fileName ? <p className="mt-3 break-all text-[12px] text-muted">{fileName}</p> : null}
        </label>

        {issues.length > 0 ? (
          <div role="alert" className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-700">
            <p className="font-semibold">Структура файла не прошла проверку</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {issues.slice(0, 8).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            {issues.length > 8 ? <p className="mt-2">Ещё ошибок: {issues.length - 8}</p> : null}
          </div>
        ) : null}

        {candidate ? <UploadPreview file={candidate} /> : null}

        {submitError ? (
          <div role="alert" className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-700">
            <p className="font-semibold">Сервер отклонил пакет</p>
            <p className="mt-1">{submitError}</p>
          </div>
        ) : null}

        {result ? (
          <div
            role="status"
            className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800"
          >
            <p className="font-semibold">
              {result.applied ? 'Данные загружены' : 'Этот пакет уже был загружен'}
            </p>
            <p className="mt-1">
              Заявки: +{result.requestsCreated}, инженеры: +{result.engineersCreated}, базы: +
              {result.depotsCreated}
              {'errors' in result && result.errors.length > 0
                ? `. Ошибки: ${result.errors.join('; ')}`
                : '.'}
            </p>
            {result.warnings.map((warning) => (
              <p key={warning} className="mt-1">
                {warning}
              </p>
            ))}
          </div>
        ) : null}

        <details className="mt-4 rounded-2xl bg-canvas px-4 py-3 text-[13px] text-muted">
          <summary className="cursor-pointer font-medium text-ink">Формат файла</summary>
          <p className="mt-2">
            Общие поля: <code>schemaVersion: &quot;1.0&quot;</code>, <code>mode</code>,{' '}
            <code>region</code>, <code>sourceVersion</code>, <code>requests</code>.
          </p>
          <p className="mt-1">
            Для <code>new_region</code> обязательны <code>depot</code> и <code>engineers</code>. Для{' '}
            <code>append_requests</code> их быть не должно. Координаты — WGS84, времена — Unix
            секунды.
          </p>
        </details>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="rounded-full border border-line px-4 py-2 text-sm disabled:opacity-50"
          >
            {result ? 'Закрыть' : 'Отмена'}
          </button>
          {!result ? (
            <button
              type="button"
              disabled={!candidate || submitting}
              onClick={() => {
                if (!candidate) return;
                setSubmitError(null);
                void onUpload(candidate)
                  .then(setResult)
                  .catch((error: unknown) =>
                    setSubmitError(
                      error instanceof Error ? error.message : 'Не удалось загрузить пакет',
                    ),
                  );
              }}
              className="flex items-center gap-2 rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-45"
            >
              <Upload className="h-4 w-4" />
              {submitting ? 'Загружаем…' : 'Загрузить'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function UploadPreview({ file }: { readonly file: DataUploadFile }) {
  const style = regionStyle(file.region);
  return (
    <div className="mt-4 rounded-2xl border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: style.color }} />
          <span className="font-semibold">{style.label}</span>
        </div>
        <span className="rounded-full bg-canvas px-2.5 py-1 text-[12px] text-muted">
          {file.mode === 'new_region' ? 'Новый регион' : 'Дополнительные заявки'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <PreviewMetric label="Заявки" value={file.requests.length} />
        <PreviewMetric label="Инженеры" value={file.engineers?.length ?? 0} />
        <PreviewMetric label="Версия" value={file.sourceVersion} />
      </div>
    </div>
  );
}

function PreviewMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number;
}) {
  return (
    <div className="rounded-xl bg-canvas px-3 py-2">
      <span className="block text-[11px] text-muted">{label}</span>
      <span className="mt-1 block truncate font-semibold">{value}</span>
    </div>
  );
}
