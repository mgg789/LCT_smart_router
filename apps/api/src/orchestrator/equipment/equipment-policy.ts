import { APP_STATE_KEYS, type Tx } from '../../persistence';
import { type DispatcherSettings, parseDispatcherSettings } from '../settings/dispatcher-settings';

/** Read physical limits inside the same transaction as loading or snapshot publication. */
export async function readEquipmentSettings(tx: Tx): Promise<DispatcherSettings> {
  const row = await tx.appState.findUnique({ where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS } });
  return parseDispatcherSettings(row?.value);
}

/** Physical units carried together; one visit consumes one unit of its required kind. */
export interface EquipmentColumns {
  equipmentRouter: number;
  equipmentSetTopBox: number;
  equipmentSmartSpeaker: number;
}

const columns = ['equipmentRouter', 'equipmentSetTopBox', 'equipmentSmartSpeaker'] as const;

/** Company ceiling for one engineer, including legacy public-transport profiles. */
export function equipmentCapacity(transport: string, settings: DispatcherSettings): number {
  if (transport === 'car') return settings.equipmentCapacityCar;
  if (transport === 'bike') return settings.equipmentCapacityBike;
  return settings.equipmentCapacityWalk;
}

/** Counts all equipment kinds against a single carrying ceiling. */
export function equipmentTotal(stock: EquipmentColumns): number {
  return columns.reduce((sum, key) => sum + stock[key], 0);
}

/** Demand has priority; spare units are added in stable type order only when they fit. */
export function equipmentWithSpares(demand: EquipmentColumns, capacity: number): EquipmentColumns {
  if (equipmentTotal(demand) > capacity)
    throw new Error('Assigned equipment exceeds carrying capacity');
  const result = { ...demand };
  for (const key of columns) {
    if (demand[key] > 0 && equipmentTotal(result) < capacity) result[key] += 1;
  }
  return result;
}

/** Rebalances an unissued provisional basket without inventing or discarding physical stock. */
export function capProvisionalEquipment(
  stock: EquipmentColumns,
  capacity: number,
): EquipmentColumns {
  let remaining = capacity;
  const result: EquipmentColumns = {
    equipmentRouter: 0,
    equipmentSetTopBox: 0,
    equipmentSmartSpeaker: 0,
  };
  for (const key of columns) {
    result[key] = Math.min(stock[key], remaining);
    remaining -= result[key];
  }
  return result;
}
