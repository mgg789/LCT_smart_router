import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { TabularField, TabularFileInput } from '@lct/shared';
import { parse } from 'csv-parse/sync';
import { decode } from 'iconv-lite';
import readXlsxFile from 'read-excel-file/node';
import { SysError } from '../../common/errors';
import { normalizeAddress } from './dataset.parser';

export const TABULAR_MAX_BYTES = 6 * 1024 * 1024;
export const TABULAR_MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
export const TABULAR_MAX_ROWS = 5_000;
export const TABULAR_MAX_COLUMNS = 64;
export const TABULAR_MAX_CELL_LENGTH = 2_000;
const TABULAR_MAX_ZIP_ENTRIES = 512;

export const TABULAR_FIELDS: readonly TabularField[] = [
  'externalId',
  'addressText',
  'lat',
  'lon',
  'workType',
  'workCategory',
  'duration',
  'windowStart',
  'windowEnd',
  'priority',
  'requiredSkill',
  'brigade',
  'transportType',
  'requiredTransport',
];

export interface TabularRow {
  readonly rowNumber: number;
  readonly values: string[];
}

export interface ParsedTabular {
  readonly bytes: Buffer;
  readonly format: 'csv' | 'tsv' | 'xlsx';
  readonly encoding: string;
  readonly delimiter: string | null;
  readonly sheetNames: string[];
  readonly selectedSheet: number;
  readonly headerRow: number;
  readonly headers: string[];
  readonly rows: TabularRow[];
  readonly columns: Partial<Record<TabularField, number>>;
  readonly missing: Array<{ readonly field: TabularField; readonly count: number }>;
  readonly officeAddress: string | null;
  readonly notices: string[];
  readonly durationUnit: 'minutes' | 'seconds';
  readonly sourceHash: string;
}

interface RawTable {
  readonly rows: string[][];
  readonly format: 'csv' | 'tsv' | 'xlsx';
  readonly encoding: string;
  readonly delimiter: string | null;
  readonly sheetNames: string[];
  readonly selectedSheet: number;
  readonly notices: string[];
}

const HEADER_ALIASES: Readonly<Record<TabularField, readonly string[]>> = {
  externalId: ['externalid', 'external id', 'id', 'номер', 'заявка', 'код заявки'],
  addressText: ['addresstext', 'address', 'адрес', 'адрес клиента', 'точка'],
  lat: ['lat', 'latitude', 'широта', 'координата широта'],
  lon: ['lon', 'lng', 'longitude', 'долгота', 'координата долгота'],
  workCategory: ['workcategory', 'work category', 'группа заявки', 'категория заявки'],
  workType: ['worktype', 'work type', 'type', 'тип работы', 'тип заявки', 'тип заявки hd'],
  duration: ['duration', 'длительность', 'норма', 'время работы', 'service duration'],
  windowStart: ['windowstart', 'window start', 'начало', 'окно от'],
  windowEnd: ['windowend', 'window end', 'окончание', 'окно до'],
  priority: ['priority', 'приоритет'],
  requiredSkill: ['requiredskill', 'skill', 'навык', 'квалификация'],
  brigade: ['brigade', 'бригада', 'инженер', 'engineer'],
  transportType: ['transporttype', 'transport type', 'транспорт', 'тип транспорта'],
  requiredTransport: ['requiredtransport', 'required transport', 'нужный транспорт'],
};

/** Reads a bounded CSV, TSV, or XLSX source and produces a reviewable table. */
export async function parseTabular(input: TabularFileInput): Promise<ParsedTabular> {
  const bytes = decodeBase64(input.payloadBase64);
  const format = detectFormat(input.fileName, bytes);
  if (format === 'xlsx') {
    enforceZipBounds(bytes);
  }
  const raw =
    format === 'xlsx' ? await readWorkbook(bytes, input) : readDelimited(bytes, input, format);
  const headerIndex = selectHeaderRow(raw.rows, input.headerRow);
  const headers = raw.rows[headerIndex] ?? [];
  validateHeader(headers);
  validateDimensions(raw.rows.slice(headerIndex + 1), headers.length);
  const allRows: TabularRow[] = raw.rows.slice(headerIndex + 1).map((values, index) => ({
    rowNumber: headerIndex + index + 2,
    values,
  }));
  const notices = [...raw.notices];
  let rows = allRows;
  let trailingBlankRows = 0;
  while (true) {
    const last = rows.at(-1);
    if (!last || !isBlankRow(last)) break;
    rows = rows.slice(0, -1);
    trailingBlankRows += 1;
  }
  if (trailingBlankRows > 0)
    notices.push(`Пустые завершающие строки не включены в предпросмотр: ${trailingBlankRows}.`);
  const columns = mapColumns(headers, notices);
  const officeAddress = findOfficeAddress(rows);
  if (officeAddress) {
    notices.push('Строка «Адрес офиса» распознана как депо и не будет заявкой.');
  }
  const ragged = rows.filter((row) => row.values.length !== headers.length);
  if (ragged.length > 0) {
    notices.push(`Сохранены строки с неполным числом ячеек: ${ragged.length}.`);
  }
  const durationUnit = inferDurationUnit(headers, columns.duration, rows);
  const missing = TABULAR_FIELDS.map((field) => {
    const index = columns[field];
    const count = rows.filter((row) => {
      if (isOfficeRow(row) || isBlankRow(row)) return false;
      return index === undefined || isBlank(row.values[index]);
    }).length;
    return { field, count };
  }).filter((item) => item.count > 0);
  return {
    bytes,
    format: raw.format,
    encoding: raw.encoding,
    delimiter: raw.delimiter,
    sheetNames: raw.sheetNames,
    selectedSheet: raw.selectedSheet,
    headerRow: headerIndex + 1,
    headers,
    rows,
    columns,
    missing,
    officeAddress,
    notices,
    durationUnit,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
}

function decodeBase64(payload: string): Buffer {
  const compact = payload.replace(/\s+/gu, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
    throw SysError.validationFailed('Tabular payload is not valid base64');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) {
    throw SysError.validationFailed('Tabular payload is empty');
  }
  if (bytes.length > TABULAR_MAX_BYTES) {
    throw SysError.validationFailed('Tabular file exceeds the 6 MiB compressed limit', {
      maxBytes: TABULAR_MAX_BYTES,
    });
  }
  return bytes;
}

function detectFormat(fileName: string, bytes: Buffer): 'csv' | 'tsv' | 'xlsx' {
  const lower = fileName.toLocaleLowerCase('en-US');
  if (!/\.(csv|tsv|xlsx)$/u.test(lower)) {
    throw SysError.validationFailed('Поддерживаются файлы CSV, TSV и XLSX.');
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'xlsx';
  }
  if (lower.endsWith('.xlsx'))
    throw SysError.validationFailed('Файл XLSX повреждён: ожидается ZIP-книга.');
  return lower.endsWith('.tsv') ? 'tsv' : 'csv';
}

function readDelimited(bytes: Buffer, input: TabularFileInput, format: 'csv' | 'tsv'): RawTable {
  const encoding = chooseEncoding(bytes, input.encoding ?? 'auto');
  const text = decodeText(bytes, encoding);
  if (Buffer.byteLength(text, 'utf8') > TABULAR_MAX_EXPANDED_BYTES) {
    throw SysError.validationFailed('Tabular text exceeds the 32 MiB expanded limit');
  }
  const delimiter =
    input.delimiter && input.delimiter !== 'auto'
      ? input.delimiter
      : format === 'tsv'
        ? '\t'
        : detectDelimiter(text);
  const notices: string[] = [];
  let rows: string[][];
  try {
    rows = toStringRows(
      parse(text, {
        bom: true,
        delimiter,
        relax_column_count: true,
        skip_empty_lines: false,
      }),
    );
  } catch (error) {
    // A malformed quote is recoverable if we retain the physical rows and tell the
    // dispatcher that the preview came from a conservative fallback parser.
    rows = fallbackDelimitedRows(text, delimiter);
    notices.push(
      `В CSV обнаружена ошибка кавычек; строки сохранены консервативным разбором (${error instanceof Error ? error.message : 'неизвестная ошибка'}).`,
    );
  }
  return {
    rows,
    format,
    encoding,
    delimiter,
    sheetNames: [],
    selectedSheet: 1,
    notices,
  };
}

async function readWorkbook(bytes: Buffer, input: TabularFileInput): Promise<RawTable> {
  try {
    const sheets = await readXlsxFile(bytes);
    const sheetNames = sheets.map((item) => item.sheet);
    const selectedSheet = input.sheet ?? 1;
    const sheet = sheets[selectedSheet - 1];
    if (!sheet) {
      throw SysError.validationFailed(`XLSX sheet ${selectedSheet} does not exist`, {
        sheetNames,
      });
    }
    const rows = sheet.data.map((row) => row.map((cell) => cellToText(cell)));
    return {
      rows,
      format: 'xlsx',
      encoding: 'xlsx',
      delimiter: null,
      sheetNames,
      selectedSheet,
      notices: ['Формулы XLSX не вычисляются; используются сохранённые значения ячеек.'],
    };
  } catch (error) {
    if (error instanceof SysError) throw error;
    throw SysError.validationFailed('XLSX file is corrupt or cannot be read', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const year = cell.getUTCFullYear();
    const month = String(cell.getUTCMonth() + 1).padStart(2, '0');
    const day = String(cell.getUTCDate()).padStart(2, '0');
    const hour = String(cell.getUTCHours()).padStart(2, '0');
    const minute = String(cell.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  return String(cell);
}

function chooseEncoding(
  bytes: Buffer,
  requested: NonNullable<TabularFileInput['encoding']>,
): string {
  if (requested === 'windows1251') return 'windows-1251';
  if (requested === 'utf8') return 'utf8';
  if (requested === 'utf16le') return 'utf16le';
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return 'utf16le';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf8';
  } catch {
    return 'windows-1251';
  }
}

function decodeText(bytes: Buffer, encoding: string): string {
  try {
    return encoding === 'utf8' || encoding === 'utf16le'
      ? bytes.toString(encoding)
      : decode(bytes, encoding);
  } catch (error) {
    throw SysError.validationFailed('Tabular text cannot be decoded with the selected encoding', {
      encoding,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const lines = text
    .split(/\r?\n/u)
    .filter((item) => item.trim() !== '')
    .slice(0, 30);
  return candidates.reduce(
    (best, candidate) => {
      // Score the densest physical row so a prose preamble containing commas cannot
      // outweigh the actual semicolon-delimited header and records.
      const count = Math.max(...lines.map((line) => countUnquoted(line, candidate)), -1);
      return count > best.count ? { candidate, count } : best;
    },
    { candidate: ',', count: -1 },
  ).candidate;
}

function countUnquoted(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function toStringRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
      : [],
  );
}

function fallbackDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  const lines = text.split(/\r?\n/u);
  for (const line of lines) {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (!quoted && char === delimiter) {
        row.push(cell);
        cell = '';
      } else {
        cell += char;
      }
    }
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  }
  if (row.length > 0 || cell.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function selectHeaderRow(rows: string[][], requested: number | undefined): number {
  if (rows.length === 0) throw SysError.validationFailed('Tabular file has no rows');
  const index =
    requested === undefined ? rows.findIndex((row) => headerScore(row) > 0) : requested - 1;
  const selected = index < 0 ? 0 : index;
  if (selected >= rows.length) {
    throw SysError.validationFailed('Selected header row is outside the source');
  }
  if (rows[selected]?.every((cell) => isBlank(cell))) {
    throw SysError.validationFailed('Selected header row is blank');
  }
  return selected;
}

function headerScore(row: string[]): number {
  const normalized = row.map(normalizeHeader);
  return TABULAR_FIELDS.reduce(
    (score, field) =>
      score + (normalized.some((value) => matchesAlias(value, HEADER_ALIASES[field])) ? 1 : 0),
    0,
  );
}

function mapColumns(headers: string[], notices: string[]): Partial<Record<TabularField, number>> {
  const columns: Partial<Record<TabularField, number>> = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const field = TABULAR_FIELDS.find((candidate) =>
      matchesAlias(normalized, HEADER_ALIASES[candidate]),
    );
    if (!field) return;
    if (
      field === 'workType' &&
      normalized.includes('тип заявки bk') &&
      headers.some((item) => normalizeHeader(item) === 'тип заявки hd')
    ) {
      return;
    }
    if (columns[field] !== undefined) {
      notices.push(`Для поля ${field} найдено несколько колонок; используется первая.`);
      return;
    }
    columns[field] = index;
  });
  return columns;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/[«»"'().:_/-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function matchesAlias(value: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const normalized = normalizeHeader(alias);
    return value === normalized || value.includes(normalized);
  });
}

function inferDurationUnit(
  headers: string[],
  durationIndex: number | undefined,
  rows: readonly TabularRow[],
): 'minutes' | 'seconds' {
  const header = durationIndex === undefined ? '' : normalizeHeader(headers[durationIndex] ?? '');
  if (/(sec|second|сек|с$)/u.test(header)) return 'seconds';
  const values =
    durationIndex === undefined
      ? []
      : rows
          .map((row) => Number.parseFloat(row.values[durationIndex] ?? ''))
          .filter(Number.isFinite);
  return values.some((value) => value >= 300) ? 'seconds' : 'minutes';
}

function findOfficeAddress(rows: readonly TabularRow[]): string | null {
  for (const row of rows) {
    const markerIndex = row.values.findIndex((value) => normalizeHeader(value) === 'адрес офиса');
    if (markerIndex < 0) continue;
    const after = row.values.slice(markerIndex + 1).find((value) => !isBlank(value));
    if (after) return after.trim();
  }
  return null;
}

export function isOfficeRow(row: Pick<TabularRow, 'values'>): boolean {
  return row.values.some((value) => normalizeHeader(value) === 'адрес офиса');
}

function isBlankRow(row: Pick<TabularRow, 'values'>): boolean {
  return row.values.every((value) => isBlank(value));
}

export function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function validateDimensions(rows: readonly string[][], headerLength: number): void {
  if (rows.length > TABULAR_MAX_ROWS) {
    throw SysError.validationFailed('Tabular file exceeds the 5,000 data-row limit', {
      maxRows: TABULAR_MAX_ROWS,
    });
  }
  if (headerLength > TABULAR_MAX_COLUMNS) {
    throw SysError.validationFailed('Tabular file exceeds the 64-column limit', {
      maxColumns: TABULAR_MAX_COLUMNS,
    });
  }
  rows.forEach((row, rowIndex) => {
    if (row.length > TABULAR_MAX_COLUMNS) {
      throw SysError.validationFailed(`Row ${rowIndex + 1} exceeds the 64-column limit`);
    }
    row.forEach((cell, columnIndex) => {
      if (cell.length > TABULAR_MAX_CELL_LENGTH) {
        throw SysError.validationFailed(
          `Cell ${rowIndex + 1}:${columnIndex + 1} exceeds the 2,000-character limit`,
        );
      }
    });
  });
}

function validateHeader(headers: readonly string[]): void {
  if (headers.length > TABULAR_MAX_COLUMNS) {
    throw SysError.validationFailed('Tabular file exceeds the 64-column limit', {
      maxColumns: TABULAR_MAX_COLUMNS,
    });
  }
  headers.forEach((cell, index) => {
    if (cell.length > TABULAR_MAX_CELL_LENGTH) {
      throw SysError.validationFailed(`Header cell ${index + 1} exceeds the 2,000-character limit`);
    }
  });
}

/** Bounds actual expansion and verifies the same local records the streaming XLSX reader sees. */
function enforceZipBounds(bytes: Buffer): void {
  if (bytes.length < 22) throw SysError.validationFailed('XLSX archive is truncated');
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw SysError.validationFailed('XLSX archive has no central directory');
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entries > TABULAR_MAX_ZIP_ENTRIES) {
    throw SysError.validationFailed('XLSX archive has too many ZIP entries', {
      maxEntries: TABULAR_MAX_ZIP_ENTRIES,
    });
  }
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== entries ||
    centralOffset + centralSize !== eocd
  ) {
    throw SysError.validationFailed('XLSX central directory is outside the archive');
  }
  let cursor = centralOffset;
  let expanded = 0;
  let actualExpanded = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw SysError.validationFailed('XLSX central directory is corrupt');
    }
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > eocd) throw SysError.validationFailed('XLSX directory entry is truncated');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const nameKey = name.toString('hex');
    if (names.has(nameKey)) throw SysError.validationFailed('XLSX has duplicate ZIP entries');
    names.add(nameKey);
    expanded += expandedSize;
    if (expanded > TABULAR_MAX_EXPANDED_BYTES) {
      throw SysError.validationFailed('XLSX archive exceeds the 32 MiB expanded limit', {
        maxBytes: TABULAR_MAX_EXPANDED_BYTES,
      });
    }
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw SysError.validationFailed('XLSX local entry is corrupt');
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const flags = bytes.readUInt16LE(localOffset + 6);
    const crc = bytes.readUInt32LE(cursor + 16);
    if (
      (flags & 1) !== 0 ||
      flags !== bytes.readUInt16LE(cursor + 8) ||
      bytes.readUInt16LE(localOffset + 8) !== bytes.readUInt16LE(cursor + 10) ||
      !name.equals(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))
    )
      throw SysError.validationFailed('XLSX local and central entries disagree');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw SysError.validationFailed('XLSX entry is truncated');
    let localEnd = dataEnd;
    if ((flags & 8) !== 0) {
      if (
        ![0, compressedSize].includes(bytes.readUInt32LE(localOffset + 18)) ||
        ![0, expandedSize].includes(bytes.readUInt32LE(localOffset + 22))
      )
        throw SysError.validationFailed('XLSX local streaming sizes disagree with its directory');
      if (dataEnd + 12 > centralOffset)
        throw SysError.validationFailed('XLSX descriptor is truncated');
      const descriptor = bytes.readUInt32LE(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      localEnd = descriptor + 12;
      if (
        localEnd > centralOffset ||
        bytes.readUInt32LE(descriptor) !== crc ||
        bytes.readUInt32LE(descriptor + 4) !== compressedSize ||
        bytes.readUInt32LE(descriptor + 8) !== expandedSize
      )
        throw SysError.validationFailed('XLSX descriptor disagrees with its directory');
    } else if (
      bytes.readUInt32LE(localOffset + 14) !== crc ||
      bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
      bytes.readUInt32LE(localOffset + 22) !== expandedSize
    )
      throw SysError.validationFailed('XLSX local sizes disagree with its directory');
    ranges.push({ start: localOffset, end: localEnd });
    const method = bytes.readUInt16LE(localOffset + 8);
    if (method !== 0 && method !== 8)
      throw SysError.validationFailed('XLSX uses an unsupported ZIP compression method');
    const remaining = TABULAR_MAX_EXPANDED_BYTES - actualExpanded;
    if (remaining <= 0)
      throw SysError.validationFailed('XLSX archive exceeds the 32 MiB expanded limit');
    const compressed = bytes.subarray(dataStart, dataEnd);
    let actual: Buffer;
    try {
      actual =
        method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: remaining });
    } catch (error) {
      throw SysError.validationFailed('XLSX entry cannot be decompressed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    actualExpanded += actual.length;
    if (actual.length !== expandedSize)
      throw SysError.validationFailed('XLSX expanded size disagrees with its directory');
    if (actual.length > remaining || actualExpanded > TABULAR_MAX_EXPANDED_BYTES) {
      throw SysError.validationFailed('XLSX archive exceeds the 32 MiB expanded limit', {
        maxBytes: TABULAR_MAX_EXPANDED_BYTES,
      });
    }
    cursor = centralEnd;
    if (compressedSize > TABULAR_MAX_EXPANDED_BYTES) {
      throw SysError.validationFailed('XLSX entry is unreasonably large');
    }
  }
  let localCursor = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.start !== localCursor)
      throw SysError.validationFailed('XLSX contains unlisted or overlapping local entries');
    localCursor = range.end;
  }
  if (localCursor !== centralOffset || cursor !== eocd) {
    throw SysError.validationFailed('XLSX contains unlisted ZIP data');
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/** Loads only the checked, official offline geocode cache used by tabular conversion. */
export function loadTabularGeocodes(
  datasetRoot: string,
): Map<string, { lat: number; lon: number }> {
  const directory = resolve(datasetRoot, '..', 'geocoded');
  const result = new Map<string, { lat: number; lon: number }>();
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return result;
  }
  for (const name of names) {
    const path = resolve(directory, name);
    try {
      if (!statSync(path).isFile()) continue;
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(raw) || !Array.isArray(raw.entries)) continue;
      for (const entry of raw.entries) {
        if (!isRecord(entry) || typeof entry.address !== 'string' || !isRecord(entry.location))
          continue;
        const lat = entry.location.lat;
        const lon = entry.location.lon;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        result.set(normalizeAddress(entry.address), { lat, lon });
      }
    } catch {
      // A broken optional regional cache must not turn an upload into an external lookup.
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
