import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EquipmentLogisticsView } from '../api/live';
import { DESIGN_PREVIEW_PLAN } from './designPreview';
import { equipmentLogisticsMessage } from './EquipmentLogisticsStatus';
import { engineerListItems } from './engineerDay';
import { EngineerListCard } from './RequestCards';

const entry: EquipmentLogisticsView = {
  id: 'delivery-1',
  kind: 'donor_delivery',
  state: 'assigned',
  requestId: 'request-1',
  equipmentType: 'router',
  donorEngineerId: 'donor',
  donorName: 'Алексей',
  receiverEngineerId: 'receiver',
  depotId: null,
  expectedAt: 700,
  actualAt: null,
  location: { lat: 55, lon: 37 },
  action: { kind: 'equipment_delivery_confirm', enabled: true },
  retryAt: null,
  failureCode: null,
};
const stop = {
  sequence: 0,
  kind: 'delivery' as const,
  requestId: null,
  lat: 55,
  lon: 37,
  arrivalAt: 700,
  startAt: 700,
  endAt: 760,
  logistics: {
    logistics_id: entry.id,
    kind: entry.kind,
    request_id: entry.requestId,
    equipment_type: entry.equipmentType,
  },
};

describe('Equipment logistics presentation', () => {
  it('shows named ETA and keeps unavailable planning distinct from an infeasible delivery', () => {
    expect(equipmentLogisticsMessage(entry, 100)).toContain(
      'Алексей привезёт вам оборудование через 10 мин.',
    );
    expect(equipmentLogisticsMessage({ ...entry, state: 'error' }, 100)).toContain(
      'Заявка остаётся в работе',
    );
    expect(equipmentLogisticsMessage({ ...entry, state: 'none' }, 100)).toContain(
      'Заявка завершена с проблемой',
    );
  });
  it('adds the delivery stop only to the donor, without a receiver confirmation', () => {
    const plan = {
      ...DESIGN_PREVIEW_PLAN,
      route: DESIGN_PREVIEW_PLAN.route ? { ...DESIGN_PREVIEW_PLAN.route, stops: [stop] } : null,
    };
    const donor = engineerListItems(plan, null, null, [], 'donor', [entry]);
    expect(donor).toHaveLength(1);
    expect(engineerListItems(plan, null, null, [], 'receiver', [entry])).toEqual([]);
    const html = renderToStaticMarkup(
      <EngineerListCard
        item={{ kind: 'logistics', stop, logistics: entry }}
        motionOn={false}
        delay={0}
        logisticsAction={() => undefined}
      />,
    );
    expect(html).toContain('Передал');
    expect(html).not.toContain('Ожидаем подтверждение партнёра');
  });
  it('requires only pickup confirmation in the office and disables unavailable actions', () => {
    const html = renderToStaticMarkup(
      <EngineerListCard
        item={{
          kind: 'logistics',
          stop: { ...stop, kind: 'office_pickup' },
          logistics: {
            ...entry,
            kind: 'office_pickup',
            action: { kind: 'office_pickup_confirm', enabled: false },
          },
        }}
        motionOn={false}
        delay={0}
        logisticsAction={() => undefined}
      />,
    );
    expect(html).toContain('Забрать в офисе');
    expect(html).toContain('Принял');
    expect(html).toContain('disabled');
  });
});
