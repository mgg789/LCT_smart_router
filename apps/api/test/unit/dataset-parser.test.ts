import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encode } from 'iconv-lite';
import { parseSyntheticFile } from '../../src/orchestrator/imports/dataset.parser';

describe('official dataset parser', () => {
  it('attaches the canonical norm breakdown without adding road to service time', () => {
    const csv = [
      'Заявка;Тип заявки BK;Тип заявки HD;Начало;Окончание;Район;Адрес;Бригада',
      '1;;Заявка на подключение;16.09.2026 09:00;16.09.2026 10:00;Тест;Москва, тест;Бригада 1',
    ].join('\n');

    const parsed = parseSyntheticFile('east', encode(csv, 'win1251'), 3 * 3600);

    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(
      parsed.requests.map((request) => ({
        normProfileCode: request.normProfileCode,
        normativeTravelDurationSec: request.normativeTravelDurationSec,
        technicalDurationSec: request.technicalDurationSec,
        documentationDurationSec: request.documentationDurationSec,
        serviceDurationSec: request.serviceDurationSec,
      })),
      [
        {
          normProfileCode: 'connection_base',
          normativeTravelDurationSec: 1200,
          technicalDurationSec: 3600,
          documentationDurationSec: 600,
          serviceDurationSec: 4200,
        },
      ],
    );
  });

  it('rejects calendar values that Date.UTC would otherwise normalize', () => {
    const csv = [
      'Заявка;Тип заявки BK;Тип заявки HD;Начало;Окончание;Район;Адрес;Бригада',
      '1;;Заявка на подключение;31.02.2026 09:00;31.02.2026 10:00;Тест;Москва, тест;Бригада 1',
    ].join('\n');

    const parsed = parseSyntheticFile('east', encode(csv, 'win1251'), 3 * 3600);

    assert.equal(parsed.requests.length, 0);
    assert.deepEqual(parsed.errors, ['Invalid time window for request 1']);
  });
});
