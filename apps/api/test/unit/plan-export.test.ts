import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { PlanView, RequestView } from '@lct/shared';
import ExcelJS from 'exceljs';
import { renderPlanWorkbook } from '../../src/api/plan-export';

const request: RequestView = {
  id: 'REQ-1',
  version: 1,
  lifecycle: 'submitted',
  assignmentState: 'assigned',
  addressText: 'Москва, ул. Ленина, д. 1',
  region: 'east',
  lat: 55.7,
  lon: 37.7,
  needsGeocoding: false,
  geocodeQuality: null,
  requiredEquipment: null,
  workType: 'repair',
  workTypeTitle: 'Ремонт',
  requiredSkill: 'local',
  serviceDurationSec: 3600,
  windowStartAt: 1_779_600_000,
  windowEndAt: 1_779_607_200,
  priority: 'normal',
  contactName: 'Клиент',
  problemText: null,
  createdAt: 1,
  submittedAt: 1,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
};

const plan: PlanView = {
  revision: 7,
  origin: 'auto',
  planAsOf: 1,
  appliedAt: 1,
  routes: [
    {
      engineerId: 'ENG-1',
      startLat: 55.7,
      startLon: 37.7,
      startAt: 1_779_600_000,
      finishAt: 1_779_606_000,
      distanceKm: 5,
      travelTimeSec: 600,
      workTimeSec: 3600,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 1,
      lunchStatus: 'none',
      legs: [],
      stops: [
        {
          sequence: 1,
          kind: 'job',
          requestId: 'REQ-1',
          lat: 55.7,
          lon: 37.7,
          arrivalAt: 1_779_600_600,
          startAt: 1_779_600_600,
          endAt: 1_779_604_200,
        },
      ],
    },
  ],
  assignments: [
    { requestId: 'REQ-1', status: 'assigned', engineerId: 'ENG-1', reasons: {} },
    { requestId: 'REQ-2', status: 'unassigned', engineerId: null, reasons: {} },
  ],
};

test('plan export has schedule and full detail sheets, including unassigned requests', async () => {
  const bytes = await renderPlanWorkbook({
    plan,
    engineerNames: new Map([['ENG-1', 'Ирина Соколова']]),
    requests: new Map([
      [
        'REQ-1',
        {
          view: request,
          clientEmail: 'client@example.test',
          passport: {
            connectionType: 'fiber',
            difficulty: 2,
            equipment: 'router',
            accessNotes: 'Код домофона',
            comment: 'Вход со двора',
          },
        },
      ],
      ['REQ-2', { view: { ...request, id: 'REQ-2' }, clientEmail: null, passport: null }],
    ]),
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([bytes]));
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['План по инженерам', 'Все заявки'],
  );
  assert.equal(workbook.worksheets[0]?.getRow(2).getCell(1).value, 'Ирина Соколова');
  assert.equal(workbook.worksheets[0]?.getRow(2).getCell(3).value, 'REQ-1');
  assert.equal(workbook.worksheets[1]?.getRow(2).getCell(6).value, '60');
  assert.equal(workbook.worksheets[1]?.getRow(2).getCell(12).value, 'client@example.test');
  assert.equal(workbook.worksheets[1]?.getRow(2).getCell(16).value, 'Код домофона');
  assert.equal(workbook.worksheets[1]?.getRow(3).getCell(1).value, 'Не назначен');
});
