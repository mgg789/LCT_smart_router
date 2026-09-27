import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeTabular, convertTabular } from './tabular';

afterEach(() => vi.unstubAllGlobals());

const source = {
  fileName: 'requests.tsv',
  payloadBase64: 'Y29sdW1ucw==',
  delimiter: '\t' as const,
};

const analysis = {
  sourceHash: 'hash',
  format: 'tsv' as const,
  encoding: 'utf8',
  delimiter: '\t',
  sheetNames: [],
  selectedSheet: 1,
  headerRow: 1,
  headers: ['address'],
  rows: [{ rowNumber: 2, values: ['Москва'] }],
  columns: { addressText: 0 },
  missing: [],
  officeAddress: null,
  notices: ['Проверьте адреса'],
  durationUnit: 'minutes' as const,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tabular import API', () => {
  it('posts source choices to the read-only analyzer', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject(source);
      return json(analysis);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeTabular('session-token', source)).resolves.toMatchObject({
      format: 'tsv',
      headers: ['address'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/dispatch/data/tabular/analyze',
      expect.anything(),
    );
  });

  it('sends reviewed options to conversion and accepts canonical output', async () => {
    const canonical = {
      schemaVersion: '1.0' as const,
      mode: 'append_requests' as const,
      region: 'east',
      sourceVersion: 'tabular:hash',
      requests: [
        {
          externalId: '1',
          addressText: 'Москва',
          serviceDurationSec: 600,
          windowStartAt: 1_700_000_000,
          windowEndAt: 1_700_003_600,
          priority: 'normal' as const,
          requiredSkill: 'local' as const,
          lat: 55.75,
          lon: 37.61,
        },
      ],
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        source: typeof source;
        options: { region: string };
      };
      expect(body.source).toMatchObject(source);
      expect(body.options.region).toBe('east');
      return json({ file: canonical, issues: [], notices: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      convertTabular('session-token', source, {
        mode: 'append_requests',
        region: 'east',
        workDate: '2026-09-27',
        columns: { addressText: 0 },
        defaults: { duration: '10', priority: 'normal', requiredSkill: 'local' },
        durationUnit: 'minutes',
        depot: { addressText: '' },
        engineers: {
          count: 1,
          transportType: 'car',
          skills: ['local'],
          shiftStart: '09:00',
          shiftEnd: '18:00',
        },
        edits: [],
      }),
    ).resolves.toMatchObject({ file: { region: 'east' }, issues: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/dispatch/data/tabular/convert',
      expect.anything(),
    );
  });
});
