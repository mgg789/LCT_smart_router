import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { moscowAt } from '../lib/time';
import {
  requestAssignLabel,
  requestDetailFromRow,
  requestDetailFromSnapshot,
  requestDetailTags,
  requestEquipmentLabel,
  requestIsAssigned,
  requestWindowLabel,
} from './requestDetail';
import { DEMO_REQUEST_ROWS, shortRequestId } from './requestsTable';

describe('Figma REQUET detail model', () => {
  it('formats the client window and planned arrival the way the mock paints it', () => {
    const start = moscowAt('2026-09-15', 12, 40);
    const end = moscowAt('2026-09-15', 16, 45);
    const eta = moscowAt('2026-09-15', 13, 7);
    expect(requestWindowLabel(start, end, eta)).toBe('12:40-16:45 (расчетное 13:07)');
    expect(requestWindowLabel(start, end, null)).toBe('12:40-16:45');
    expect(requestEquipmentLabel('router')).toBe('Роутер');
    expect(requestEquipmentLabel('smart_speaker')).toBe('Умная колонка');
  });

  it('builds chips from skill, urgency and required equipment — no invented client type', () => {
    const tags = requestDetailTags({
      requiredSkill: 'connection',
      priority: 'urgent',
      requiredEquipment: 'router',
    } as never);
    expect(tags.primary).toEqual(['Подключение', 'Срочная']);
    expect(tags.equipment).toEqual(['Роутер']);
  });

  it('maps a live snapshot request onto the REQUET panel slots', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests[0];
    expect(request).toBeTruthy();
    if (!request) throw new Error('Fixture must include a request');
    const detail = requestDetailFromSnapshot(snapshot, request.id);
    expect(detail?.numberLabel).toBe(`Заявка № ${shortRequestId(request.id)}`);
    expect(detail?.title).toBe(request.workTypeTitle || 'Заявка');
    expect(detail?.address).toBe(request.addressText);
    expect(detail?.email).toBeNull();
    expect(detail?.engineerLabel.startsWith('Инженер:')).toBe(true);
    expect(detail?.windowLabel).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}/);
    expect(typeof detail?.assigned).toBe('boolean');
    expect(requestAssignLabel(false)).toBe('Назначить инженера');
    expect(requestAssignLabel(true)).toBe('Переназначить инженера');
    expect(requestIsAssigned({ assignmentState: 'unassigned' }, null)).toBe(false);
  });

  it('keeps the offline table row readable when there is no snapshot', () => {
    const row = DEMO_REQUEST_ROWS[0];
    if (!row) throw new Error('Fixture must include a request row');
    const detail = requestDetailFromRow(row);
    expect(detail.numberLabel).toBe('Заявка № 1024');
    expect(detail.title).toBe(row.service);
    expect(detail.engineerLabel).toBe(`Инженер: ${row.engineer}`);
  });
});
