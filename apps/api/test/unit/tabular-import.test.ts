import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { encode } from 'iconv-lite';
import { parseTabular } from '../../src/orchestrator/imports/tabular.parser';
import { TabularImportService } from '../../src/orchestrator/imports/tabular-import.service';

const config = {
  get: (key: string): string => (key === 'DATASET_ROOT' ? 'data/dataset/anonymized' : ''),
};

function input(fileName: string, text: Buffer | string) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return { fileName, payloadBase64: bytes.toString('base64') };
}

test('analyzes cp1251 CSV, office marker, and physical rows', async () => {
  const source = encode(
    'Преамбула\nЗаявка;Адрес;Тип заявки HD;Начало;Окончание\n1;Москва, ул. Тест, д. 1;Мониторинг;09:00;10:00\nАдрес Офиса;Москва, ул. Офис, д. 1;;;\n',
    'win1251',
  );
  const result = await parseTabular(input('source.csv', source));
  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.headerRow, 2);
  assert.equal(result.rows[0]?.rowNumber, 3);
  assert.equal(result.officeAddress, 'Москва, ул. Офис, д. 1');
  assert.equal(result.columns.workType, 2);
});

test('parses every checked-in official CSV without losing request rows', async () => {
  const directory = resolve(process.cwd(), '../../data/dataset/anonymized');
  const expected: Readonly<Record<string, number>> = {
    'east_control_distribution.csv': 66,
    'east_synthetic_data.csv': 66,
    'south_central_control_distribution.csv': 56,
    'south_central_synthetic_data.csv': 56,
    'southeast_control_distribution.csv': 83,
    'southeast_synthetic_data.csv': 83,
  };
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.csv'))) {
    const result = await parseTabular(input(name, readFileSync(resolve(directory, name))));
    const requestRows = result.rows.filter(
      (row) => row.values.some((value) => value.trim() !== '') && !isOfficeMarker(row.values),
    );
    assert.equal(requestRows.length, expected[name], name);
    assert.equal(result.encoding, 'windows-1251', name);
  }
});

test('converts all official files with offline geocodes and reports uncovered control addresses', async () => {
  const directory = resolve(process.cwd(), '../../data/dataset/anonymized');
  const service = new TabularImportService({
    get: (key: string): string => (key === 'DATASET_ROOT' ? directory : ''),
  } as never);
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.csv'))) {
    const source = input(name, readFileSync(resolve(directory, name)));
    const analysis = await service.analyze(source);
    const result = await service.convert({
      source,
      options: {
        mode: 'append_requests',
        region: 'tabular_test',
        workDate: '2026-09-27',
        columns: analysis.columns,
        defaults: {},
        durationUnit: analysis.durationUnit,
        depot: { addressText: '' },
        engineers: {
          count: 9,
          transportType: 'car',
          skills: ['local', 'connection', 'emergency'],
          shiftStart: '09:00',
          shiftEnd: '18:00',
        },
        edits: [],
      },
    });
    if (name.includes('synthetic')) {
      assert.equal(result.issues.length, 0, name);
      assert.equal(result.file?.requests.length, expectedRequestCount(name), name);
      assert.ok((result.file?.requests[0]?.windowStartAt ?? 0) > 1_000_000_000, name);
    } else {
      assert.ok(
        result.issues.some((issue) => issue.field === 'lat'),
        name,
      );
      assert.equal(result.file, null, name);
    }
  }
});

test('detects TSV and preserves a recoverable quote error', async () => {
  const tsv = await parseTabular(input('source.tsv', 'id\taddress\n1\t"Москва, ул. Тест"\n'));
  assert.equal(tsv.format, 'tsv');
  assert.equal(tsv.delimiter, '\t');
  const broken = await parseTabular(input('broken.csv', 'id,address\n1,"quoted, value\n2,plain\n'));
  assert.ok(broken.notices.some((notice) => notice.includes('ошибка кавычек')));
  assert.equal(broken.rows.length, 2);
  assert.equal(broken.rows[1]?.rowNumber, 3);
});

test('rejects oversized and corrupt sources before business conversion', async () => {
  const oversized = Buffer.alloc(6 * 1024 * 1024 + 1, 0x61);
  await assert.rejects(() => parseTabular(input('large.csv', oversized)), /6 MiB/u);
  await assert.rejects(
    () => parseTabular(input('broken.xlsx', Buffer.from('PK\x03\x04broken'))),
    /XLSX/u,
  );
});

test('converts with missing-cell defaults and leaves the service write-free', async () => {
  const service = new TabularImportService(config as never);
  const source = input(
    'source.csv',
    'id,address,workType,start,end,lat,lon\n1,"Москва, ул. Тест, д. 1",Мониторинг,09:00,10:00,55.7,37.7\n',
  );
  const result = await service.convert({
    source,
    options: {
      mode: 'append_requests',
      region: 'tabular_test',
      workDate: '2026-09-27',
      columns: {
        externalId: 0,
        addressText: 1,
        workType: 2,
        windowStart: 3,
        windowEnd: 4,
        lat: 5,
        lon: 6,
      },
      defaults: {},
      durationUnit: 'minutes',
      depot: { addressText: '' },
      engineers: {
        count: 1,
        transportType: 'car',
        skills: ['local'],
        shiftStart: '08:00',
        shiftEnd: '18:00',
      },
      edits: [],
    },
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.file?.requests.length, 1);
  assert.equal(result.file?.engineers, undefined);
  assert.equal(result.file?.depot, undefined);
});

test('uses approved mappings, preserves seconds and rejects invalid source dates', async () => {
  const service = new TabularImportService(config as never);
  const source = input(
    'clock.csv',
    'id,address,lat,lon,start,end\n1,Test,55.7,37.7,2026-08-17T06:00:15Z,18:00\n',
  );
  const options = {
    mode: 'append_requests' as const,
    region: 'east',
    workDate: '2026-09-27',
    columns: { externalId: 0, addressText: 1, lat: 2, lon: 3, windowStart: 4, windowEnd: 5 },
    defaults: { duration: '30', priority: 'normal', requiredSkill: 'local' },
    durationUnit: 'minutes' as const,
    depot: { addressText: '' },
    engineers: {
      count: 1,
      transportType: 'car' as const,
      skills: ['local' as const],
      shiftStart: '09:00',
      shiftEnd: '18:00',
    },
    edits: [],
  };
  const converted = await service.convert({ source, options });
  assert.deepEqual(converted.issues, []);
  assert.equal(
    converted.file?.requests[0]?.windowStartAt,
    Date.parse('2026-09-27T06:00:15Z') / 1000,
  );
  for (const invalid of ['31.02.2026 09:00', '09:00:99', 'garbage 09:00']) {
    const result = await service.convert({
      source,
      options: { ...options, edits: [{ rowNumber: 2, field: 'windowStart', value: invalid }] },
    });
    assert.ok(
      result.issues.some((issue) => issue.field === 'windowStart'),
      invalid,
    );
  }
  const unmapped = await service.convert({
    source,
    options: {
      ...options,
      columns: { ...options.columns, addressText: undefined },
      defaults: { ...options.defaults, addressText: 'Approved replacement' },
    },
  });
  assert.equal(unmapped.file?.requests[0]?.addressText, 'Approved replacement');
});

test('reads a bounded valid XLSX sheet and rejects a ZIP bomb declaration', async () => {
  const workbook = makeXlsx([
    ['externalId', 'addressText'],
    ['1', 'Москва, ул. Тест, д. 1'],
  ]);
  const result = await parseTabular(input('source.xlsx', workbook));
  assert.equal(result.format, 'xlsx');
  assert.equal(result.sheetNames[0], 'Sheet1');
  assert.equal(result.rows[0]?.values[0], '1');

  const bomb = Buffer.from(workbook);
  // Central directory uncompressed size for the first entry; the parser must reject by
  // declared and actual bounds before read-excel-file allocates an unbounded buffer.
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(33 * 1024 * 1024, central + 24);
  await assert.rejects(() => parseTabular(input('bomb.xlsx', bomb)), /32 MiB/u);
});

test('rejects hidden local ZIP entries and conflicting local sizes', async () => {
  const workbook = makeXlsx([
    ['id', 'address'],
    ['1', 'Test'],
  ]);
  const eocd = workbook.length - 22;
  const centralOffset = workbook.readUInt32LE(eocd + 16);
  const firstLength = 46 + workbook.readUInt16LE(centralOffset + 28);
  // Remove one directory entry while retaining the local file that the streaming reader sees.
  const hidden = Buffer.concat([
    workbook.subarray(0, centralOffset),
    workbook.subarray(centralOffset + firstLength),
  ]);
  const hiddenEnd = hidden.length - 22;
  hidden.writeUInt16LE(4, hiddenEnd + 8);
  hidden.writeUInt16LE(4, hiddenEnd + 10);
  hidden.writeUInt32LE(workbook.readUInt32LE(eocd + 12) - firstLength, hiddenEnd + 12);
  await assert.rejects(() => parseTabular(input('hidden.xlsx', hidden)), /unlisted/u);
  const mismatched = Buffer.from(workbook);
  mismatched.writeUInt32LE(1, 18);
  await assert.rejects(() => parseTabular(input('mismatch.xlsx', mismatched)), /local sizes/u);
});

function makeXlsx(rows: readonly string[][]): Buffer {
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`,
    )
    .join('');
  const files: ReadonlyArray<[string, string]> = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ],
  ];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    chunks.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

function columnName(index: number): string {
  return String.fromCharCode(65 + index);
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isOfficeMarker(values: readonly string[]): boolean {
  return values.some((value) => value.trim().toLocaleLowerCase('ru-RU') === 'адрес офиса');
}

function expectedRequestCount(name: string): number {
  return name.startsWith('east_') ? 66 : name.startsWith('south_central_') ? 56 : 83;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('requires an explicit group for a new source type and keeps its original name', async () => {
  const service = new TabularImportService(config as never);
  const source = input(
    'new-type.csv',
    'id,address,workType,start,end,lat,lon\n1,Test,Новый тип,09:00,18:00,55.7,37.7\n',
  );
  const options = {
    mode: 'append_requests' as const,
    region: 'east',
    workDate: '2026-09-27',
    columns: {
      externalId: 0,
      addressText: 1,
      workType: 2,
      windowStart: 3,
      windowEnd: 4,
      lat: 5,
      lon: 6,
    },
    defaults: { duration: '30', priority: 'normal', requiredSkill: 'local' },
    durationUnit: 'minutes' as const,
    depot: { addressText: '' },
    engineers: {
      count: 1,
      transportType: 'car' as const,
      skills: ['local' as const],
      shiftStart: '09:00',
      shiftEnd: '18:00',
    },
    edits: [],
  };
  const missing = await service.convert({ source, options });
  assert.ok(missing.issues.some((issue) => issue.field === 'workCategory'));
  const explicit = await service.convert({
    source,
    options: { ...options, defaults: { ...options.defaults, workCategory: 'emergency' } },
  });
  assert.equal(explicit.issues.length, 0);
  assert.equal(explicit.file?.requests[0]?.workType, 'Новый тип');
  assert.equal(explicit.file?.requests[0]?.workCategory, 'emergency');
  assert.equal(explicit.file?.requests[0]?.serviceDurationSec, 6000);
});
