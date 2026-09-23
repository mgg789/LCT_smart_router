import type { TransportType } from '../model/types';

const TRANSPORT_TITLES: Record<TransportType, string> = {
  car: 'Легковой автомобиль',
  walk: 'Пешком',
  bike: 'Велосипед',
  transit: 'Общественный транспорт',
};

/** Russian name of a transport profile; an unknown code is shown as it came. */
export function transportTitleOf(transport: TransportType): string {
  return TRANSPORT_TITLES[transport] ?? transport;
}
