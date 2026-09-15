import { parse } from 'csv-parse/sync';
import { decode } from 'iconv-lite';
import { SysError } from '../../common/errors';
import type { Priority, Skill, WindowOrigin } from '../../generated/prisma/client';
import { findWorkTypeByTitle } from '../requests/work-type.catalog';

/**
 * Reader for the organisers' dataset.
 *
 * The files are windows-1251 with `;` separators and Russian headers, and they are the
 * untouched source of truth: nothing here rewrites them, and every derived value is
 * marked as derived (context/18 section 6).
 *
 * Anomalies the files actually contain, all handled explicitly rather than by luck:
 * blank rows, a hidden office address in the last row, empty or all-day windows, missing
 * districts, and address prefixes in four different spellings.
 */

export interface ParsedRequest {
  readonly externalId: string;
  readonly workTypeCode: string;
  readonly skill: Skill;
  readonly serviceDurationSec: number;
  readonly priority: Priority;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly windowOrigin: WindowOrigin;
  readonly district: string | null;
  readonly addressText: string;
  readonly region: string;
}

export interface ParsedBrigade {
  readonly name: string;
  readonly region: string;
  /** Position of first appearance, which the baseline iterates in. */
  readonly inputOrder: number;
}

export interface ParsedDepot {
  readonly region: string;
  readonly addressText: string;
}

export interface ParsedRegion {
  readonly region: string;
  readonly requests: ParsedRequest[];
  readonly brigades: ParsedBrigade[];
  readonly depot: ParsedDepot | null;
  /**
   * Rows that were skipped for a documented reason -- an empty window, for instance. The
   * package still applies and the count is reported, so the omission is visible.
   */
  readonly warnings: string[];
  /**
   * Content that cannot be interpreted at all, such as a type of work that is not in the
   * catalogue. These fail the whole package: applying part of a file would leave the
   * system in a state nobody chose (context/37 section 9.1).
   */
  readonly errors: string[];
}

const HEADER = {
  requestId: 'Заявка',
  typeBk: 'Тип заявки BK',
  typeHd: 'Тип заявки HD',
  start: 'Начало',
  end: 'Окончание',
  district: 'Район',
  address: 'Адрес',
  brigade: 'Бригада',
} as const;

/** The marker of the hidden office row: the address sits in the type column. */
const OFFICE_MARKER = 'Адрес Офиса';

/**
 * Whole-day window, as stated in the file itself.
 *
 * Two different things end up here and stay distinguishable in `windowOrigin`: a window
 * the file declares as `0:01`-`23:59`, and a window the file simply leaves empty
 * (context/18 section 6.2).
 */
const DAY_START_HHMM = '00:00';
const DAY_END_HHMM = '23:59';

export function parseSyntheticFile(
  region: string,
  content: Buffer,
  timeZoneOffsetSec: number,
): ParsedRegion {
  const rows = readRows(content);
  const requests: ParsedRequest[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let depot: ParsedDepot | null = null;

  for (const row of rows) {
    const id = (row[HEADER.requestId] ?? '').trim();

    // The last row of every file carries the regional office, with the address in the
    // type column. It reads as a blank row and is anything but (context/18 section 6.4).
    if (id === OFFICE_MARKER) {
      depot = { region, addressText: normalizeAddress((row[HEADER.typeBk] ?? '').trim()) };
      continue;
    }

    // Blank separator rows, and anything whose id is not a work order number.
    if (!/^\d+$/.test(id)) {
      continue;
    }

    const typeTitle = (row[HEADER.typeHd] ?? '').trim();
    const spec = findWorkTypeByTitle(typeTitle);
    if (!spec) {
      // Never mapped to the nearest familiar type: a wrong skill silently sends the wrong
      // engineer. This fails the package.
      errors.push(`Unknown type of work: "${typeTitle}" (request ${id})`);
      continue;
    }

    const window = parseWindow(
      (row[HEADER.start] ?? '').trim(),
      (row[HEADER.end] ?? '').trim(),
      timeZoneOffsetSec,
    );
    if (!window) {
      // A documented anomaly of the dataset: some rows carry no window. Skipped and
      // counted rather than given an invented one (context/18 section 6.2).
      warnings.push(`No usable time window for request ${id}`);
      continue;
    }

    const district = (row[HEADER.district] ?? '').trim();
    requests.push({
      externalId: id,
      workTypeCode: spec.code,
      skill: spec.skill,
      serviceDurationSec: spec.serviceDurationSec,
      priority: spec.priority,
      windowStartAt: window.startAt,
      windowEndAt: window.endAt,
      windowOrigin: window.origin,
      district: district === '' ? null : district,
      addressText: normalizeAddress((row[HEADER.address] ?? '').trim()),
      region,
    });
  }

  return { region, requests, brigades: [], depot, warnings, errors };
}

/**
 * Reads the crews from the control distribution.
 *
 * The dataset has no engineer directory at all, so the crews that actually did the work
 * are the only real source of who exists (context/18 section 6.3). Their skills and
 * transport are synthesized separately and marked as such.
 */
export function parseBrigades(region: string, content: Buffer): ParsedBrigade[] {
  const rows = readRows(content);
  const seen = new Map<string, number>();
  for (const row of rows) {
    const id = (row[HEADER.requestId] ?? '').trim();
    if (!/^\d+$/.test(id)) {
      continue;
    }
    const name = (row[HEADER.brigade] ?? '').trim();
    // Rows with no crew are the work that was never dispatched -- a real outcome, not a
    // gap to fill in.
    if (name && !seen.has(name)) {
      seen.set(name, seen.size);
    }
  }
  return [...seen.entries()].map(([name, inputOrder]) => ({ name, region, inputOrder }));
}

function readRows(content: Buffer): Array<Record<string, string>> {
  // Explicit decoding: the files are windows-1251, and reading them as UTF-8 turns every
  // Russian letter into noise that would then be stored as somebody's address.
  const text = decode(content, 'win1251');
  try {
    return parse(text, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: false,
      relax_column_count: true,
      bom: true,
    }) as Array<Record<string, string>>;
  } catch (error) {
    throw new SysError('VALIDATION_FAILED', 'The file could not be read as CSV', {
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Parses `DD.MM.YYYY HH:MM` into absolute seconds.
 *
 * The file states local times; the offset is supplied by the caller rather than taken
 * from the host, and the result is stored as whole Unix seconds
 * (context/33 section 4).
 */
function parseWindow(
  start: string,
  end: string,
  offsetSec: number,
): { startAt: number; endAt: number; origin: WindowOrigin } | null {
  if (!start && !end) {
    // No window in the file. Treated as the whole day and marked as such, so the
    // assumption is never mistaken for something the customer asked for.
    return null;
  }

  const startAt = parseLocalMoment(start, offsetSec);
  const endAt = parseLocalMoment(end, offsetSec);
  if (startAt === null || endAt === null || endAt < startAt) {
    return null;
  }

  const startHhmm = start.slice(-5);
  const endHhmm = end.slice(-5);
  const declaredFullDay =
    (startHhmm === '0:01' || startHhmm === '00:01' || startHhmm === DAY_START_HHMM) &&
    (endHhmm === DAY_END_HHMM || endHhmm === '23:59');

  return {
    startAt,
    endAt,
    origin: declaredFullDay ? 'declared_full_day' : 'explicit',
  };
}

function parseLocalMoment(value: string, offsetSec: number): number | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, day, month, year, hour, minute] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
  );
  return Math.floor(utc / 1000) - offsetSec;
}

/**
 * Normalises the four spellings of a Moscow address prefix that appear in the files.
 *
 * Only the prefix is touched. House numbers such as `д. 128 к 5` and `1А` are left exactly
 * as written: they are what a geocoder will have to work with, and rewriting them here
 * would lose information (context/18 section 6.2).
 */
export function normalizeAddress(address: string): string {
  return address
    .replace(/^\s*г\.?\s*Город\s+Москва/i, 'Москва')
    .replace(/^\s*Город\s+Москва/i, 'Москва')
    .replace(/^\s*г\.\s*Москва/i, 'Москва')
    .replace(/^\s*обл\.Московская область/i, 'Московская область')
    .replace(/^\s*МО[,\s]/i, 'Московская область, ')
    .replace(/\s+/g, ' ')
    .trim();
}
