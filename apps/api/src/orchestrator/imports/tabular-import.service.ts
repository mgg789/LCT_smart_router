import { createHash } from 'node:crypto';
import type {
  DataUploadEngineer,
  DataUploadFile,
  DataUploadRequest,
  TabularAnalysis,
  TabularCompletionOptions,
  TabularConversion,
  TabularField,
  WorkCategory,
} from '@lct/shared';
import { Injectable } from '@nestjs/common';
import { uploadDataPackageSchema } from '../../api/dto/data.dto';
import type { TabularAnalyzeDto, TabularConvertDto } from '../../api/dto/tabular.dto';
import { AppConfigService } from '../../common/config';
import { findWorkType, findWorkTypeByTitle } from '../requests/work-type.catalog';
import { normalizeAddress } from './dataset.parser';
import {
  isBlank,
  isOfficeRow,
  loadTabularGeocodes,
  type ParsedTabular,
  parseTabular,
  type TabularRow,
} from './tabular.parser';

const MOSCOW_OFFSET_SEC = 3 * 60 * 60;
const SKILLS = ['local', 'connection', 'emergency'] as const;
const TRANSPORTS = ['car', 'walk', 'bike', 'transit'] as const;
type Skill = (typeof SKILLS)[number];
type Transport = (typeof TRANSPORTS)[number];

interface ConversionIssue {
  readonly rowNumber: number | null;
  readonly field: TabularField | 'depot' | 'engineers' | 'workDate';
  readonly message: string;
}

/** Analyzes and converts reviewed tabular uploads without touching business state. */
@Injectable()
export class TabularImportService {
  constructor(private readonly config: AppConfigService) {}

  /** Parses the source and returns a parsed-row preview for dispatcher review. */
  async analyze(input: TabularAnalyzeDto): Promise<TabularAnalysis> {
    const parsed = await parseTabular(input);
    return toAnalysis(parsed);
  }

  /** Converts an approved preview into the existing upload package contract. */
  async convert(input: TabularConvertDto): Promise<TabularConversion> {
    const parsed = await parseTabular(input.source);
    const issues: ConversionIssue[] = [];
    const notices = [...parsed.notices];
    const geocodes = loadTabularGeocodes(this.config.get('DATASET_ROOT'));
    const rows = parsed.rows.filter((row) => !isBlankRow(row) && !isOfficeRow(row));
    if (parsed.rows.some(isOfficeRow)) {
      notices.push('Офисная строка исключена из заявок и используется только как подсказка депо.');
    }
    const columns = input.options.columns;
    const edits = buildEdits(input.options.edits, parsed.rows, issues);
    const requests: DataUploadRequest[] = [];
    const sourceIds = new Map<string, number[]>();
    for (const row of rows) {
      const rawValue = (field: TabularField): string => {
        const edit = edits.get(`${row.rowNumber}:${field}`);
        if (edit !== undefined) return edit;
        const index = columns[field];
        return index === undefined ? '' : (row.values[index]?.trim() ?? '');
      };
      const value = (field: TabularField): string => {
        const original = rawValue(field);
        return isBlank(original) ? (input.options.defaults[field] ?? '') : original;
      };
      const sourceId = rawValue('externalId');
      const id = sourceId || `tabular-${parsed.sourceHash.slice(0, 12)}-${row.rowNumber}`;
      if (!sourceId) {
        notices.push(`Строка ${row.rowNumber}: создан детерминированный идентификатор ${id}.`);
      }
      const previous = sourceIds.get(id) ?? [];
      previous.push(row.rowNumber);
      sourceIds.set(id, previous);
      const address = value('addressText');
      const workTypeText = value('workType');
      const spec = workTypeText
        ? (findWorkTypeByTitle(workTypeText) ?? findWorkType(workTypeText))
        : undefined;
      if (!address) addIssue(issues, row.rowNumber, 'addressText', 'Адрес обязателен.');
      const workCategory = spec?.category ?? readWorkCategory(value('workCategory'));
      if (workTypeText && !spec && !workCategory)
        addIssue(
          issues,
          row.rowNumber,
          'workCategory',
          `Для типа «${workTypeText}» явно выберите группу: Авария, Подключение или Ремонт / Дозаказ. Исходное название сохранится.`,
        );

      const coordinates = readCoordinates(
        value('lat'),
        value('lon'),
        address,
        geocodes,
        row.rowNumber,
        issues,
      );
      const duration = readDuration(
        spec ? rawValue('duration') : value('duration'),
        input.options.durationUnit,
        spec?.serviceDurationSec,
        row.rowNumber,
        issues,
      );
      const priority = readPriority(
        spec ? rawValue('priority') : value('priority'),
        spec?.priority,
        row.rowNumber,
        issues,
      );
      const skill = readSkill(
        spec ? rawValue('requiredSkill') : value('requiredSkill'),
        spec?.skill,
        row.rowNumber,
        issues,
      );
      const windowStart = parseClock(value('windowStart'), input.options.workDate);
      const windowEnd = parseClock(value('windowEnd'), input.options.workDate);
      if (windowStart === null)
        addIssue(
          issues,
          row.rowNumber,
          'windowStart',
          'Ожидается время HH:MM или дата с временем.',
        );
      if (windowEnd === null)
        addIssue(issues, row.rowNumber, 'windowEnd', 'Ожидается время HH:MM или дата с временем.');
      if (windowStart !== null && windowEnd !== null && windowEnd < windowStart) {
        addIssue(issues, row.rowNumber, 'windowEnd', 'Окончание окна раньше начала.');
      }
      const requiredTransport = readTransport(
        value('requiredTransport'),
        row.rowNumber,
        'requiredTransport',
        issues,
      );
      if (
        coordinates &&
        duration !== null &&
        priority &&
        skill &&
        windowStart !== null &&
        windowEnd !== null
      ) {
        requests.push({
          externalId: id,
          addressText: normalizeAddress(address),
          lat: coordinates.lat,
          lon: coordinates.lon,
          serviceDurationSec: workCategory === 'emergency' ? 6000 : duration,
          windowStartAt: windowStart,
          windowEndAt: windowEnd,
          priority: workCategory === 'emergency' ? 'urgent' : priority,
          requiredSkill: skill,
          ...(requiredTransport ? { requiredTransport } : {}),
          ...(spec ? { workType: spec.code } : workTypeText ? { workType: workTypeText } : {}),
          ...(workCategory ? { workCategory } : {}),
        });
      }
    }
    for (const [id, rowNumbers] of sourceIds) {
      if (rowNumbers.length > 1) {
        for (const rowNumber of rowNumbers) {
          addIssue(issues, rowNumber, 'externalId', `Дублирующийся идентификатор ${id}.`);
        }
      }
    }

    const workDate = parseDate(input.options.workDate);
    if (workDate === null)
      addIssue(issues, null, 'workDate', 'Дата должна быть YYYY-MM-DD или DD.MM.YYYY.');
    const depot =
      input.options.mode === 'new_region'
        ? readDepot(input.options.depot, parsed.officeAddress, geocodes, issues)
        : null;
    const engineers =
      input.options.mode === 'new_region' && depot && workDate !== null
        ? buildEngineers(rows, columns, input.options, depot, workDate, edits, issues)
        : [];
    if (input.options.mode === 'new_region' && engineers.length === 0 && issues.length === 0) {
      addIssue(issues, null, 'engineers', 'Не удалось построить бригаду инженеров.');
    }
    if (input.options.mode === 'append_requests' && input.options.depot.addressText.trim() !== '') {
      notices.push('Настройки депо и инженеров проигнорированы для append_requests.');
    }
    if (issues.length > 0) return { file: null, issues, notices };

    const candidate: DataUploadFile = {
      schemaVersion: '1.0',
      mode: input.options.mode,
      region: input.options.region,
      sourceVersion: sourceVersion(parsed.bytes, input.source, input.options),
      requests,
      ...(input.options.mode === 'new_region' && depot ? { depot, engineers } : {}),
    };
    // The existing upload schema also guards mode-specific depot/engineer rules and has
    // a refinement, so Zod cannot `.omit()` it. Validate with a sentinel operation id and
    // strip that transport-only field from the returned DataUploadFile.
    const validated = uploadDataPackageSchema.safeParse({
      operationId: '00000000-0000-0000-0000-000000000000',
      ...candidate,
    });
    if (!validated.success) {
      for (const issue of validated.error.issues) {
        addIssue(
          issues,
          null,
          'workDate',
          `${issue.path.join('.') || 'package'}: ${issue.message}`,
        );
      }
      return { file: null, issues, notices };
    }
    return { file: candidate, issues: [], notices };
  }
}

function toAnalysis(parsed: ParsedTabular): TabularAnalysis {
  return {
    sourceHash: parsed.sourceHash,
    format: parsed.format,
    encoding: parsed.encoding,
    delimiter: parsed.delimiter,
    sheetNames: parsed.sheetNames,
    selectedSheet: parsed.selectedSheet,
    headerRow: parsed.headerRow,
    headers: parsed.headers,
    rows: parsed.rows,
    columns: parsed.columns,
    missing: parsed.missing,
    officeAddress: parsed.officeAddress,
    notices: parsed.notices,
    durationUnit: parsed.durationUnit,
  };
}

function buildEdits(
  edits: TabularConvertDto['options']['edits'],
  rows: readonly TabularRow[],
  issues: ConversionIssue[],
): Map<string, string> {
  const known = new Set(rows.map((row) => row.rowNumber));
  const result = new Map<string, string>();
  for (const edit of edits) {
    if (!known.has(edit.rowNumber)) {
      addIssue(issues, edit.rowNumber, edit.field, 'Редактируемая строка отсутствует в источнике.');
      continue;
    }
    result.set(`${edit.rowNumber}:${edit.field}`, edit.value.trim());
  }
  return result;
}

function isBlankRow(row: TabularRow): boolean {
  return row.values.every((value) => isBlank(value));
}

function readCoordinates(
  latText: string,
  lonText: string,
  address: string,
  geocodes: ReadonlyMap<string, { lat: number; lon: number }>,
  rowNumber: number,
  issues: ConversionIssue[],
): { lat: number; lon: number } | null {
  const lat = parseNumber(latText);
  const lon = parseNumber(lonText);
  if (latText || lonText) {
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      addIssue(
        issues,
        rowNumber,
        'lat',
        'Широта и долгота должны быть корректными и передаваться парой.',
      );
      addIssue(
        issues,
        rowNumber,
        'lon',
        'Широта и долгота должны быть корректными и передаваться парой.',
      );
      return null;
    }
    return { lat, lon };
  }
  const point = geocodes.get(normalizeAddress(address));
  if (point) return point;
  addIssue(
    issues,
    rowNumber,
    'lat',
    'Координаты не найдены в официальном offline-кэше; укажите широту.',
  );
  addIssue(
    issues,
    rowNumber,
    'lon',
    'Координаты не найдены в официальном offline-кэше; укажите долготу.',
  );
  return null;
}

function readDuration(
  text: string,
  unit: 'minutes' | 'seconds',
  catalogDuration: number | undefined,
  rowNumber: number,
  issues: ConversionIssue[],
): number | null {
  if (!text && catalogDuration !== undefined) return catalogDuration;
  const value = parseNumber(text);
  if (value === null || value <= 0) {
    addIssue(issues, rowNumber, 'duration', 'Длительность должна быть положительным числом.');
    return null;
  }
  const seconds = Math.round(value * (unit === 'minutes' ? 60 : 1));
  if (catalogDuration !== undefined && seconds !== catalogDuration) {
    addIssue(
      issues,
      rowNumber,
      'duration',
      `Длительность противоречит каталогу типа работы (${catalogDuration} секунд).`,
    );
    return null;
  }
  return seconds;
}

function readPriority(
  text: string,
  catalogPriority: 'normal' | 'urgent' | undefined,
  rowNumber: number,
  issues: ConversionIssue[],
): 'normal' | 'urgent' | null {
  if (!text && catalogPriority) return catalogPriority;
  const value = text.trim().toLocaleLowerCase('ru-RU');
  const priority =
    value === 'urgent' || value === 'аварийный' || value === 'срочный'
      ? 'urgent'
      : value === 'normal' || value === 'обычный'
        ? 'normal'
        : null;
  if (!priority) {
    addIssue(issues, rowNumber, 'priority', 'Приоритет должен быть normal/urgent.');
    return null;
  }
  if (catalogPriority && priority !== catalogPriority) {
    addIssue(issues, rowNumber, 'priority', 'Приоритет противоречит каталогу типа работы.');
    return null;
  }
  return priority;
}

/** Accept explicit source/UI group labels without interpreting the unknown work name. */
function readWorkCategory(text: string): WorkCategory | undefined {
  switch (text.trim().toLocaleLowerCase('ru-RU')) {
    case 'emergency':
    case 'авария':
      return 'emergency';
    case 'connection':
    case 'подключение':
      return 'connection';
    case 'service':
    case 'ремонт / дозаказ':
    case 'ремонт':
    case 'дозаказ':
      return 'service';
    default:
      return undefined;
  }
}

function readSkill(
  text: string,
  catalogSkill: Skill | undefined,
  rowNumber: number,
  issues: ConversionIssue[],
): Skill | null {
  if (!text && catalogSkill) return catalogSkill;
  const value = text.trim().toLocaleLowerCase('ru-RU');
  const skill = SKILLS.includes(value as Skill) ? (value as Skill) : null;
  if (!skill) {
    addIssue(issues, rowNumber, 'requiredSkill', 'Навык должен быть local/connection/emergency.');
    return null;
  }
  if (catalogSkill && skill !== catalogSkill) {
    addIssue(issues, rowNumber, 'requiredSkill', 'Навык противоречит каталогу типа работы.');
    return null;
  }
  return skill;
}

function readTransport(
  text: string,
  rowNumber: number,
  field: 'transportType' | 'requiredTransport',
  issues: ConversionIssue[],
): Transport | null {
  if (!text) return null;
  const value = text.trim().toLocaleLowerCase('ru-RU');
  const transport = TRANSPORTS.includes(value as Transport) ? (value as Transport) : null;
  if (!transport)
    addIssue(issues, rowNumber, field, 'Транспорт должен быть car/walk/bike/transit.');
  return transport;
}

function readDepot(
  depotOption: TabularCompletionOptions['depot'],
  officeAddress: string | null,
  geocodes: ReadonlyMap<string, { lat: number; lon: number }>,
  issues: ConversionIssue[],
): { addressText: string; lat: number; lon: number } | null {
  const addressText = depotOption.addressText.trim() || officeAddress || '';
  if (!addressText) {
    addIssue(
      issues,
      null,
      'depot',
      'Для нового региона нужен адрес депо или строка «Адрес офиса».',
    );
    return null;
  }
  const lat = depotOption.lat;
  const lon = depotOption.lon;
  if ((lat === undefined) !== (lon === undefined)) {
    addIssue(issues, null, 'depot', 'Координаты депо должны быть переданы парой.');
    return null;
  }
  const point =
    lat !== undefined && lon !== undefined
      ? { lat, lon }
      : geocodes.get(normalizeAddress(addressText));
  if (!point) {
    addIssue(issues, null, 'depot', 'Координаты депо не найдены в официальном offline-кэше.');
    return null;
  }
  return { addressText: normalizeAddress(addressText), lat: point.lat, lon: point.lon };
}

function buildEngineers(
  rows: readonly TabularRow[],
  columns: Partial<Record<TabularField, number>>,
  options: TabularCompletionOptions,
  depot: { readonly lat: number; readonly lon: number },
  workDate: string,
  edits: ReadonlyMap<string, string>,
  issues: ConversionIssue[],
): DataUploadEngineer[] {
  const shiftStartAt = parseClock(options.engineers.shiftStart, workDate);
  const shiftEndAt = parseClock(options.engineers.shiftEnd, workDate);
  if (shiftStartAt === null) addIssue(issues, null, 'engineers', 'Некорректное начало смены.');
  if (shiftEndAt === null) addIssue(issues, null, 'engineers', 'Некорректное окончание смены.');
  if (shiftStartAt !== null && shiftEndAt !== null && shiftEndAt <= shiftStartAt) {
    addIssue(issues, null, 'engineers', 'Окончание смены должно быть позже начала.');
  }
  const brigadeIndex = columns.brigade;
  const transportIndex = columns.transportType;
  const cell = (row: TabularRow, field: TabularField, index: number | undefined): string => {
    const edited = edits.get(`${row.rowNumber}:${field}`);
    if (edited !== undefined) return edited;
    const original = index === undefined ? '' : (row.values[index] ?? '');
    return isBlank(original) ? (options.defaults[field] ?? '') : original.trim();
  };
  const groups = new Map<string, { transport: Transport | null; rowNumber: number }>();
  for (const row of rows) {
    const name = cell(row, 'brigade', brigadeIndex);
    if (!name) continue;
    const text = cell(row, 'transportType', transportIndex);
    const transport = readTransport(text, row.rowNumber, 'transportType', issues);
    const previous = groups.get(name);
    if (
      previous &&
      previous.transport !== null &&
      transport !== null &&
      previous.transport !== transport
    ) {
      addIssue(
        issues,
        row.rowNumber,
        'transportType',
        `Для бригады ${name} указаны конфликтующие виды транспорта.`,
      );
    } else if (previous && previous.transport === null && transport !== null) {
      groups.set(name, { ...previous, transport });
    } else if (!previous) {
      groups.set(name, { transport, rowNumber: row.rowNumber });
    }
  }
  const names =
    groups.size > 0
      ? [...groups.keys()]
      : Array.from({ length: options.engineers.count }, (_, index) => `Engineer ${index + 1}`);
  if (shiftStartAt === null || shiftEndAt === null) return [];
  const engineerIds = new Set<string>();
  return names.map((name, index) => {
    const transport = groups.get(name)?.transport ?? options.engineers.transportType;
    const baseId = `tabular-engineer-${slug(name) || index + 1}`;
    let externalId = baseId;
    let suffix = 2;
    while (engineerIds.has(externalId)) {
      externalId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    engineerIds.add(externalId);
    return {
      externalId,
      displayName: name,
      skills: [...options.engineers.skills],
      transportType: transport,
      start: { lat: depot.lat, lon: depot.lon },
      shiftStartAt,
      shiftEndAt,
    };
  });
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function parseDate(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase('ru-RU');
  const russianMonths: Readonly<Record<string, string>> = {
    января: '01',
    февраля: '02',
    марта: '03',
    апреля: '04',
    мая: '05',
    июня: '06',
    июля: '07',
    августа: '08',
    сентября: '09',
    октября: '10',
    ноября: '11',
    декабря: '12',
  };
  const russian = normalized.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})$/u);
  const russianDay = russian?.[1];
  const russianMonth = russian?.[2];
  const russianYear = russian?.[3];
  const russianMonthNumber = russianMonth ? russianMonths[russianMonth] : undefined;
  if (russianDay && russianMonth && russianYear && russianMonthNumber) {
    return validDate(russianYear, russianMonthNumber, russianDay);
  }
  const iso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (iso?.[1] && iso[2] && iso[3]) return validDate(iso[1], iso[2], iso[3]);
  const ru = normalized.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u);
  if (ru?.[1] && ru[2] && ru[3])
    return validDate(ru[3], ru[2].padStart(2, '0'), ru[1].padStart(2, '0'));
  return null;
}

function validDate(year: string, month: string, day: string): string | null {
  const value = `${year}-${month}-${day}`;
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
    ? value
    : null;
}

function parseClock(value: string, workDate: string): number | null {
  const date = parseDate(workDate);
  const trimmed = value.trim();
  if (!date || !trimmed) return null;
  let daySeconds: number;
  const clock = trimmed.match(
    /^(?:(.+?)[T\s])?(\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/u,
  );
  if (clock) {
    const sourceDate = clock[1];
    if (sourceDate && !parseDate(sourceDate)) return null;
    const hour = Number(clock[2]);
    const minute = Number(clock[3]);
    const second = Number(clock[4] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    daySeconds = hour * 3600 + minute * 60 + second;
    const zone = clock[5];
    if (zone) {
      if (!sourceDate) return null;
      const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
      const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4));
      if (zoneHour > 23 || zoneMinute > 59) return null;
      const zoneOffset = (zoneHour * 3600 + zoneMinute * 60) * (zone.startsWith('-') ? -1 : 1);
      daySeconds = (((daySeconds - zoneOffset + MOSCOW_OFFSET_SEC) % 86400) + 86400) % 86400;
    }
  } else {
    const serial = parseNumber(trimmed);
    if (serial === null || serial < 0 || serial > 3_000_000) return null;
    // Excel dates have no timezone; preserve their clock on the selected Moscow day.
    daySeconds = Math.min(86399, Math.round((serial - Math.floor(serial)) * 86400));
  }
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - MOSCOW_OFFSET_SEC + daySeconds;
}

function sourceVersion(
  bytes: Buffer,
  source: TabularConvertDto['source'],
  options: TabularCompletionOptions,
): string {
  return createHash('sha256')
    .update(bytes)
    .update(
      JSON.stringify({
        fileName: source.fileName,
        sheet: source.sheet ?? 1,
        encoding: source.encoding ?? 'auto',
        delimiter: source.delimiter ?? 'auto',
        headerRow: source.headerRow ?? null,
        options,
      }),
    )
    .digest('hex');
}

function addIssue(
  issues: ConversionIssue[],
  rowNumber: number | null,
  field: ConversionIssue['field'],
  message: string,
): void {
  issues.push({ rowNumber, field, message });
}
