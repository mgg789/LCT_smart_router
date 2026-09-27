import type {
  TabularAnalysis,
  TabularCompletionOptions,
  TabularConversion,
  TabularField,
  TabularFileInput,
} from '@lct/shared';
import { motion } from 'framer-motion';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { analyzeTabular, convertTabular } from '../api/tabular';

const TABULAR_FIELDS: readonly TabularField[] = [
  'externalId',
  'addressText',
  'lat',
  'lon',
  'workType',
  'duration',
  'windowStart',
  'windowEnd',
  'priority',
  'requiredSkill',
  'brigade',
  'transportType',
  'requiredTransport',
];

const FIELD_LABELS: Record<TabularField, string> = {
  externalId: 'ID заявки',
  addressText: 'Адрес',
  lat: 'Широта',
  lon: 'Долгота',
  workType: 'Тип работ',
  duration: 'Длительность',
  windowStart: 'Начало окна',
  windowEnd: 'Конец окна',
  priority: 'Приоритет',
  requiredSkill: 'Навык',
  brigade: 'Бригада',
  transportType: 'Транспорт инженера',
  requiredTransport: 'Транспорт заявки',
};

const DEFAULT_VALUES: Record<TabularField, string> = {
  externalId: '',
  addressText: '',
  lat: '',
  lon: '',
  workType: '',
  duration: '60',
  windowStart: '09:00',
  windowEnd: '18:00',
  priority: 'normal',
  requiredSkill: 'local',
  brigade: '',
  transportType: 'car',
  requiredTransport: '',
};

type TabularInput = TabularFileInput & {
  readonly sheet?: number;
  readonly encoding?: TabularFileInput['encoding'];
  readonly delimiter?: TabularFileInput['delimiter'];
  readonly headerRow?: number;
};

type TabularImportDialogProps = {
  token: string;
  source: TabularFileInput;
  existingRegions: readonly string[];
  motionOn: boolean;
  onBack: () => void;
  onComplete: (file: NonNullable<TabularConversion['file']>, notices: readonly string[]) => void;
};

/** Native tabular review portal; no implicit dismissal or coordinate fabrication is allowed. */
export function TabularImportDialog({
  token,
  source,
  existingRegions,
  motionOn,
  onBack,
  onComplete,
}: TabularImportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [analysis, setAnalysis] = useState<TabularAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzedInput, setAnalyzedInput] = useState<TabularInput | null>(null);
  const [busy, setBusy] = useState(true);
  const [converting, setConverting] = useState(false);
  const [sheet, setSheet] = useState<number | undefined>(source.sheet);
  const [encoding, setEncoding] = useState<TabularFileInput['encoding']>(source.encoding ?? 'auto');
  const [delimiter, setDelimiter] = useState<TabularFileInput['delimiter']>(
    source.delimiter ?? 'auto',
  );
  const [headerRow, setHeaderRow] = useState<number | undefined>(source.headerRow);
  const [columns, setColumns] = useState<Partial<Record<TabularField, number>>>({});
  const [defaults, setDefaults] = useState<Record<TabularField, string>>(DEFAULT_VALUES);
  const [mode, setMode] = useState<TabularCompletionOptions['mode']>('new_region');
  const [region, setRegion] = useState(() => suggestRegion(source.fileName, existingRegions));
  const [workDate, setWorkDate] = useState(todayInMoscow());
  const [durationUnit, setDurationUnit] =
    useState<TabularCompletionOptions['durationUnit']>('minutes');
  const [depotAddress, setDepotAddress] = useState('');
  const [depotLat, setDepotLat] = useState('');
  const [depotLon, setDepotLon] = useState('');
  const [engineerCount, setEngineerCount] = useState('1');
  const [engineerTransport, setEngineerTransport] =
    useState<TabularCompletionOptions['engineers']['transportType']>('car');
  const [engineerSkills, setEngineerSkills] = useState<
    TabularCompletionOptions['engineers']['skills']
  >(['local']);
  const [shiftStart, setShiftStart] = useState('09:00');
  const [shiftEnd, setShiftEnd] = useState('18:00');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [conversion, setConversion] = useState<TabularConversion | null>(null);
  const analysisRun = useRef(0);

  const input = useMemo<TabularInput>(
    () => ({
      ...source,
      ...(sheet === undefined ? {} : { sheet }),
      encoding,
      delimiter,
      ...(headerRow === undefined ? {} : { headerRow }),
    }),
    [delimiter, encoding, headerRow, sheet, source],
  );
  const initialInput = useRef(input);

  const runAnalysis = useCallback(
    async (nextInput: TabularInput) => {
      const runId = ++analysisRun.current;
      setBusy(true);
      setAnalysisError(null);
      setConversion(null);
      try {
        const next = await analyzeTabular(token, nextInput);
        if (runId !== analysisRun.current) return;
        setAnalysis(next);
        setAnalyzedInput(nextInput);
        if (next.officeAddress)
          setDepotAddress((current) => (current.trim() ? current : (next.officeAddress ?? '')));
        setColumns(next.columns);
        setDurationUnit(next.durationUnit);
        setEdits({});
      } catch (cause) {
        if (runId !== analysisRun.current) return;
        setAnalysis(null);
        setAnalysisError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл');
      } finally {
        if (runId === analysisRun.current) setBusy(false);
      }
    },
    [token],
  );

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    heading.current?.focus({ preventScroll: true });
    void runAnalysis(initialInput.current);
    return () => {
      analysisRun.current += 1;
      node?.close();
    };
  }, [runAnalysis]);

  const updateEdit = (rowNumber: number, field: TabularField, value: string) => {
    setEdits((current) => ({ ...current, [`${rowNumber}:${field}`]: value }));
  };

  const updateColumn = (field: TabularField, value: string) => {
    setColumns((current) => {
      const next = { ...current };
      if (value === '') delete next[field];
      else next[field] = Number(value);
      return next;
    });
  };

  const toggleSkill = (skill: TabularCompletionOptions['engineers']['skills'][number]) => {
    setEngineerSkills((current) =>
      current.includes(skill) ? current.filter((item) => item !== skill) : [...current, skill],
    );
  };

  const submitConversion = async () => {
    if (!analysis || converting) return;
    const count = Number(engineerCount);
    const lat = depotLat.trim() === '' ? undefined : Number(depotLat);
    const lon = depotLon.trim() === '' ? undefined : Number(depotLon);
    if (!/^[a-z0-9_]{2,64}$/.test(region.trim())) {
      setConversion({
        file: null,
        issues: [
          { rowNumber: null, field: 'workDate', message: 'Регион: 2–64 символа a-z, 0-9 или _.' },
        ],
        notices: [],
      });
      return;
    }
    if (!workDate.trim() || (mode === 'new_region' && !depotAddress.trim())) {
      setConversion({
        file: null,
        issues: [
          {
            rowNumber: null,
            field: !workDate.trim() ? 'workDate' : 'depot',
            message:
              mode === 'new_region' ? 'Заполните дату и адрес базы.' : 'Заполните рабочую дату.',
          },
        ],
        notices: [],
      });
      return;
    }
    if (
      mode === 'new_region' &&
      (!Number.isInteger(count) || count < 1 || engineerSkills.length === 0)
    ) {
      setConversion({
        file: null,
        issues: [
          {
            rowNumber: null,
            field: 'engineers',
            message: 'Укажите число инженеров и хотя бы один навык.',
          },
        ],
        notices: [],
      });
      return;
    }
    if (
      (lat !== undefined && !Number.isFinite(lat)) ||
      (lon !== undefined && !Number.isFinite(lon))
    ) {
      setConversion({
        file: null,
        issues: [
          {
            rowNumber: null,
            field: 'depot',
            message: 'Координаты базы должны быть числами или пустыми.',
          },
        ],
        notices: [],
      });
      return;
    }
    const cleanDefaults = Object.fromEntries(
      TABULAR_FIELDS.filter((field) => defaults[field].trim() !== '').map((field) => [
        field,
        defaults[field].trim(),
      ]),
    ) as Partial<Record<TabularField, string>>;
    const options: TabularCompletionOptions = {
      mode,
      region: region.trim(),
      workDate: workDate.trim(),
      columns,
      defaults: cleanDefaults,
      durationUnit,
      depot: {
        addressText: mode === 'new_region' ? depotAddress.trim() : '',
        ...(mode === 'new_region' && lat === undefined
          ? {}
          : mode === 'new_region' && lat !== undefined
            ? { lat }
            : {}),
        ...(mode === 'new_region' && lon === undefined
          ? {}
          : mode === 'new_region' && lon !== undefined
            ? { lon }
            : {}),
      },
      engineers: {
        count,
        transportType: engineerTransport,
        skills: engineerSkills,
        shiftStart: shiftStart.trim(),
        shiftEnd: shiftEnd.trim(),
      },
      edits: Object.entries(edits).map(([key, value]) => {
        const separator = key.indexOf(':');
        const rowNumber = Number(key.slice(0, separator));
        const field = key.slice(separator + 1) as TabularField;
        return { rowNumber, field, value };
      }),
    };
    setConverting(true);
    const conversionRun = analysisRun.current;
    try {
      const result = await convertTabular(token, analyzedInput ?? input, options);
      if (conversionRun !== analysisRun.current) return;
      setConversion(result);
      if (result.file) onComplete(result.file, result.notices);
    } catch (cause) {
      if (conversionRun !== analysisRun.current) return;
      setConversion({
        file: null,
        issues: [
          {
            rowNumber: null,
            field: 'workDate',
            message: cause instanceof Error ? cause.message : 'Не удалось преобразовать файл',
          },
        ],
        notices: [],
      });
    } finally {
      if (conversionRun === analysisRun.current) setConverting(false);
    }
  };

  if (typeof document === 'undefined') return null;
  const analysisReady =
    analysis !== null && analyzedInput !== null && sameTabularInput(analyzedInput, input);
  const fieldForColumn = new Map(
    Object.entries(columns).map(([field, index]) => [index, field as TabularField]),
  );
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
      className="fixed inset-0 m-auto max-h-[92dvh] w-[min(96vw,1180px)] max-w-none overflow-hidden rounded-[20px] border-0 bg-white p-0 text-figma-ink backdrop:bg-figma-ink/40"
    >
      <motion.div
        initial={motionOn ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex max-h-[92dvh] flex-col"
      >
        <div className="shrink-0 px-[24px] pt-[24px]">
          <h2 ref={heading} tabIndex={-1} id={titleId} className="font-extrabold text-[24px]">
            Проверка таблицы: {source.fileName}
          </h2>
          <p className="mt-[8px] text-[15px] text-figma-muted">
            Проверьте сопоставление столбцов и значения для пропусков. Неизвестные адреса потребуют
            уточнения координат.
          </p>
        </div>
        <div className="min-h-0 overflow-y-auto px-[24px] py-[16px]">
          <section className="rounded-[16px] bg-figma-soft p-[16px]">
            <h3 className="font-semibold text-[17px]">Источник</h3>
            <div className="mt-[10px] grid grid-cols-2 gap-[10px] md:grid-cols-4">
              <TabularFieldControl label="Кодировка">
                <select
                  value={encoding}
                  onChange={(event) =>
                    setEncoding(event.target.value as TabularFileInput['encoding'])
                  }
                  className="tabular-control-input"
                >
                  <option value="auto">Авто</option>
                  <option value="utf8">UTF-8</option>
                  <option value="windows1251">Windows-1251</option>
                  <option value="utf16le">UTF-16 LE</option>
                </select>
              </TabularFieldControl>
              <TabularFieldControl label="Разделитель">
                <select
                  value={delimiter}
                  onChange={(event) =>
                    setDelimiter(event.target.value as TabularFileInput['delimiter'])
                  }
                  className="tabular-control-input"
                >
                  <option value="auto">Авто</option>
                  <option value=",">Запятая</option>
                  <option value=";">Точка с запятой</option>
                  <option value="\t">Табуляция</option>
                  <option value="|">Вертикальная черта</option>
                </select>
              </TabularFieldControl>
              <TabularFieldControl label="Строка заголовка">
                <input
                  type="number"
                  min={1}
                  value={headerRow ?? analysis?.headerRow ?? 1}
                  onChange={(event) => setHeaderRow(Math.max(1, Number(event.target.value) || 1))}
                  className="tabular-control-input"
                />
              </TabularFieldControl>
              {analysis?.format === 'xlsx' ? (
                <TabularFieldControl label="Лист">
                  <select
                    value={sheet ?? analysis.selectedSheet}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setSheet(next);
                      void runAnalysis({ ...input, sheet: next });
                    }}
                    className="tabular-control-input"
                  >
                    {analysis.sheetNames.map((name) => (
                      <option key={name} value={analysis.sheetNames.indexOf(name) + 1}>
                        {name}
                      </option>
                    ))}
                  </select>
                </TabularFieldControl>
              ) : null}
            </div>
            <button
              type="button"
              disabled={busy || converting}
              onClick={() => void runAnalysis(input)}
              className="mt-[12px] rounded-[12px] bg-figma-ink px-[16px] py-[10px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Читаем файл…' : 'Перечитать файл'}
            </button>
          </section>

          {analysisError ? (
            <p
              role="alert"
              className="mt-[12px] rounded-[14px] bg-[#fdecec] p-[12px] text-figma-danger"
            >
              {analysisError}
            </p>
          ) : null}
          {analysis ? (
            <>
              <section className="mt-[16px] rounded-[16px] bg-figma-canvas p-[16px]">
                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                  <h3 className="font-semibold text-[17px]">Сопоставление колонок</h3>
                  <span className="text-[13px] text-figma-muted">
                    {analysis.rows.length > 25
                      ? `Показаны первые 25 из ${analysis.rows.length}`
                      : `${analysis.rows.length} строк`}{' '}
                    · заголовок {analysis.headerRow}
                  </span>
                </div>
                <div className="mt-[10px] grid grid-cols-2 gap-[8px] md:grid-cols-3 lg:grid-cols-4">
                  {TABULAR_FIELDS.map((field) => (
                    <TabularFieldControl key={field} label={FIELD_LABELS[field]}>
                      <select
                        value={columns[field] ?? ''}
                        onChange={(event) => updateColumn(field, event.target.value)}
                        className="tabular-control-input"
                      >
                        <option value="">Нет колонки</option>
                        {analysis.headers.map((header, index) => (
                          <option key={header || 'empty-column'} value={index}>
                            {index + 1}. {header || '(пусто)'}
                          </option>
                        ))}
                      </select>
                    </TabularFieldControl>
                  ))}
                </div>
              </section>

              <section className="mt-[16px] rounded-[16px] bg-figma-canvas p-[16px]">
                <h3 className="font-semibold text-[17px]">Явные значения для пропусков</h3>
                <div className="mt-[10px] grid grid-cols-2 gap-[8px] md:grid-cols-3 lg:grid-cols-4">
                  {TABULAR_FIELDS.map((field) => (
                    <TabularFieldControl key={field} label={FIELD_LABELS[field]}>
                      <input
                        value={defaults[field]}
                        onChange={(event) =>
                          setDefaults((current) => ({ ...current, [field]: event.target.value }))
                        }
                        placeholder="Оставить пустым"
                        className="tabular-control-input"
                      />
                    </TabularFieldControl>
                  ))}
                </div>
                <div className="mt-[10px] flex flex-wrap gap-[8px]">
                  <label className="flex items-center gap-[6px] text-[14px]">
                    <span>Единица длительности</span>
                    <select
                      value={durationUnit}
                      onChange={(event) =>
                        setDurationUnit(
                          event.target.value as TabularCompletionOptions['durationUnit'],
                        )
                      }
                      className="tabular-control-input"
                    >
                      <option value="minutes">Минуты</option>
                      <option value="seconds">Секунды</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="mt-[16px] rounded-[16px] bg-figma-soft p-[16px]">
                <h3 className="font-semibold text-[17px]">Параметры импорта</h3>
                <div className="mt-[10px] grid grid-cols-2 gap-[8px] md:grid-cols-4">
                  <TabularFieldControl label="Режим">
                    <select
                      value={mode}
                      onChange={(event) =>
                        setMode(event.target.value as TabularCompletionOptions['mode'])
                      }
                      className="tabular-control-input"
                    >
                      <option value="new_region">Новый регион</option>
                      <option value="append_requests">Дополнить заявки</option>
                    </select>
                  </TabularFieldControl>
                  <TabularFieldControl label="Регион">
                    <input
                      list="tabular-region-options"
                      value={region}
                      onChange={(event) => setRegion(event.target.value.toLowerCase())}
                      placeholder="east"
                      className="tabular-control-input"
                    />
                    <datalist id="tabular-region-options">
                      {existingRegions.map((item) => (
                        <option key={item} value={item} />
                      ))}
                    </datalist>
                  </TabularFieldControl>
                  <TabularFieldControl label="Рабочая дата">
                    <input
                      type="date"
                      value={workDate}
                      onChange={(event) => setWorkDate(event.target.value)}
                      className="tabular-control-input"
                    />
                  </TabularFieldControl>
                  {mode === 'new_region' ? (
                    <>
                      <TabularFieldControl label="Адрес базы">
                        <input
                          value={depotAddress}
                          onChange={(event) => setDepotAddress(event.target.value)}
                          placeholder="Не подставляется автоматически"
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                      <TabularFieldControl label="Широта базы">
                        <input
                          value={depotLat}
                          onChange={(event) => setDepotLat(event.target.value)}
                          placeholder="не обязательно"
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                      <TabularFieldControl label="Долгота базы">
                        <input
                          value={depotLon}
                          onChange={(event) => setDepotLon(event.target.value)}
                          placeholder="не обязательно"
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                      <TabularFieldControl label="Инженеры (если в файле нет бригад)">
                        <input
                          type="number"
                          min={1}
                          value={engineerCount}
                          onChange={(event) => setEngineerCount(event.target.value)}
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                      <TabularFieldControl label="Транспорт">
                        <select
                          value={engineerTransport}
                          onChange={(event) =>
                            setEngineerTransport(event.target.value as typeof engineerTransport)
                          }
                          className="tabular-control-input"
                        >
                          <option value="car">Авто</option>
                          <option value="walk">Пешком</option>
                          <option value="bike">Велосипед</option>
                          <option value="transit">Общественный</option>
                        </select>
                      </TabularFieldControl>
                      <TabularFieldControl label="Начало смены">
                        <input
                          type="time"
                          value={shiftStart}
                          onChange={(event) => setShiftStart(event.target.value)}
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                      <TabularFieldControl label="Конец смены">
                        <input
                          type="time"
                          value={shiftEnd}
                          onChange={(event) => setShiftEnd(event.target.value)}
                          className="tabular-control-input"
                        />
                      </TabularFieldControl>
                    </>
                  ) : null}
                </div>
                {mode === 'new_region' ? (
                  <>
                    <div className="mt-[10px] flex flex-wrap gap-[10px] text-[14px]">
                      {(['local', 'connection', 'emergency'] as const).map((skill) => (
                        <label key={skill} className="flex items-center gap-[5px]">
                          <input
                            type="checkbox"
                            checked={engineerSkills.includes(skill)}
                            onChange={() => toggleSkill(skill)}
                          />
                          {skill === 'local'
                            ? 'Локальный'
                            : skill === 'connection'
                              ? 'Подключение'
                              : 'Аварийный'}
                        </label>
                      ))}
                    </div>
                    <p className="mt-[8px] text-[13px] text-figma-muted">
                      Известные официальные адреса разрешаются сервером. Для остальных оставьте
                      координаты пустыми и укажите их вручную при необходимости.
                    </p>
                  </>
                ) : (
                  <p className="mt-[8px] text-[13px] text-figma-muted">
                    Для дополнения заявок база и параметры инженеров не требуются.
                  </p>
                )}
              </section>

              <section className="mt-[16px] overflow-hidden rounded-[16px] bg-white ring-1 ring-figma-track">
                <div className="overflow-auto">
                  <table className="min-w-full text-left text-[13px]">
                    <thead className="bg-figma-soft">
                      <tr>
                        {analysis.headers.map((header, index) => (
                          <th
                            key={header || 'empty-column'}
                            className="whitespace-nowrap px-[8px] py-[7px] font-semibold"
                          >
                            {header || `Колонка ${index + 1}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.rows.slice(0, 25).map((row) => (
                        <tr key={row.rowNumber} className="border-t border-figma-track">
                          {analysis.headers.map((_, index) => {
                            const field = fieldForColumn.get(index);
                            const original = row.values[index] ?? '';
                            const key = field ? `${row.rowNumber}:${field}` : '';
                            return (
                              <td
                                key={`${row.rowNumber}-${field ?? original}`}
                                className="max-w-[220px] px-[8px] py-[5px] align-top"
                              >
                                {field ? (
                                  <input
                                    value={edits[key] ?? original}
                                    onChange={(event) =>
                                      updateEdit(row.rowNumber, field, event.target.value)
                                    }
                                    className="w-full min-w-[100px] rounded-[6px] border border-figma-track px-[6px] py-[4px]"
                                  />
                                ) : (
                                  <span>{original}</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}

          {conversion?.issues.length ? (
            <div role="alert" className="mt-[12px] rounded-[14px] bg-[#fdecec] p-[12px]">
              <p className="font-semibold text-figma-danger">Исправьте значения перед импортом</p>
              <ul className="mt-[6px] space-y-[6px] pl-[18px] text-[14px]">
                {conversion.issues.map((issue) => {
                  const editable = issue.rowNumber !== null && isTabularField(issue.field);
                  const key = editable ? `${issue.rowNumber}:${issue.field}` : null;
                  return (
                    <li key={`${issue.rowNumber ?? 'global'}-${issue.field}-${issue.message}`}>
                      {issue.rowNumber ? `Строка ${issue.rowNumber}: ` : ''}
                      {FIELD_LABELS[issue.field as TabularField] ?? issue.field}: {issue.message}
                      {editable && key ? (
                        <input
                          value={edits[key] ?? ''}
                          placeholder="Введите исправленное значение"
                          onChange={(event) =>
                            updateEdit(
                              issue.rowNumber ?? 0,
                              issue.field as TabularField,
                              event.target.value,
                            )
                          }
                          className="mt-[4px] block w-full rounded-[7px] border border-figma-track bg-white px-[7px] py-[5px]"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {analysis?.notices.map((notice) => (
            <p key={notice} className="mt-[8px] text-[13px] text-figma-muted">
              {notice}
            </p>
          ))}
          {conversion?.notices.map((notice) => (
            <p key={notice} className="mt-[8px] text-[13px] text-figma-muted">
              {notice}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 justify-end gap-[12px] border-t border-figma-track p-[20px]">
          <button
            type="button"
            disabled={converting}
            onClick={onBack}
            className="rounded-[18px] bg-figma-track px-[22px] py-[13px] font-semibold disabled:opacity-50"
          >
            Вернуться
          </button>
          <button
            type="button"
            disabled={!analysisReady || busy || converting}
            onClick={() => void submitConversion()}
            className="rounded-[18px] bg-figma-bee px-[22px] py-[13px] font-semibold disabled:opacity-50"
          >
            {converting ? 'Проверяем…' : 'Проверить заполнение'}
          </button>
        </div>
      </motion.div>
    </dialog>,
    document.body,
  );
}

/** Links the visible field label to its native control without including option text. */
export function TabularFieldControl({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="block min-w-0 text-[13px] font-medium">
      <label htmlFor={id} className="mb-[4px] block text-figma-muted">
        {label}
      </label>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) &&
        typeof child.type === 'string' &&
        ['input', 'select', 'textarea'].includes(child.type)
          ? cloneElement(child, { id })
          : child,
      )}
    </div>
  );
}

function todayInMoscow(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function sameTabularInput(left: TabularInput, right: TabularInput): boolean {
  return (
    left.fileName === right.fileName &&
    left.payloadBase64 === right.payloadBase64 &&
    left.sheet === right.sheet &&
    left.encoding === right.encoding &&
    left.delimiter === right.delimiter &&
    left.headerRow === right.headerRow
  );
}

function suggestRegion(fileName: string, existingRegions: readonly string[]): string {
  const normalized = fileName.toLowerCase();
  const known = ['south_central', 'southeast', 'east'] as const;
  return known.find((item) => normalized.startsWith(item)) ?? existingRegions[0] ?? '';
}

function isTabularField(
  value: TabularConversion['issues'][number]['field'],
): value is TabularField {
  return TABULAR_FIELDS.includes(value as TabularField);
}
