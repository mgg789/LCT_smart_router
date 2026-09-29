import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ReadyPacksService } from '../../src/orchestrator/imports/ready-packs.service';
import { TabularImportService } from '../../src/orchestrator/imports/tabular-import.service';

describe('ready packs', () => {
  it('lists the short days before the organizer sets', () => {
    const service = new ReadyPacksService({} as never, {} as never, {} as never);
    const packs = service.list().packs;
    assert.deepEqual(
      packs.map((pack) => pack.id),
      [
        'light-east',
        'calm-east',
        'mkad-southeast',
        'storm-south',
        'official-base',
        'official-extra-days',
      ],
    );
    assert.equal(packs[0]?.group, 'demo');
    assert.equal(packs.at(-1)?.group, 'official');
  });

  it('places a short sample on the chosen work date', async () => {
    const root = resolve(__dirname, '../../../../..');
    const datasetRoot = resolve(root, 'data/dataset/anonymized');
    const fileName = '04-light-day-east-utf8.csv';
    const bytes = readFileSync(resolve(root, 'data/samples', fileName));
    const tabular = new TabularImportService({
      get: (key: string) => (key === 'DATASET_ROOT' ? datasetRoot : ''),
    } as never);
    const source = {
      fileName,
      payloadBase64: bytes.toString('base64'),
      encoding: 'auto' as const,
      delimiter: 'auto' as const,
    };
    const preview = await tabular.analyze(source);
    const converted = await tabular.convert({
      source,
      options: {
        mode: 'append_requests',
        region: 'east',
        workDate: '2026-09-29',
        columns: preview.columns,
        defaults: {},
        durationUnit: preview.durationUnit,
        depot: { addressText: '' },
        engineers: {
          count: 1,
          transportType: 'car',
          skills: ['connection'],
          shiftStart: '10:00',
          shiftEnd: '22:00',
        },
        edits: [],
      },
    });
    assert.equal(converted.issues.length, 0, JSON.stringify(converted.issues.slice(0, 3)));
    assert.ok(converted.file);
    assert.equal(converted.file.requests.length, 7);
    const first = converted.file.requests[0];
    assert.ok(first);
    const start = new Date(first.windowStartAt * 1000);
    assert.equal(start.toISOString().slice(0, 10), '2026-09-29');
  });
});
