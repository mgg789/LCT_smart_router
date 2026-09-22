import type { EquipmentType } from '../api/types';

const EQUIPMENT_RU: Record<EquipmentType, string> = {
  router: 'Роутер',
  set_top_box: 'Приставка',
  smart_speaker: 'Умная колонка',
};

/** Equipment chip on Figma REQUEST 78:9734. */
export function equipmentLabel(kind: EquipmentType | null): string | null {
  if (kind === null) return null;
  return EQUIPMENT_RU[kind];
}

/**
 * Yandex Maps driving directions to the job.
 * Coordinates win; address is the fallback when the point is not geocoded.
 */
export function engineerMapsUrl(input: {
  lat: number | null;
  lon: number | null;
  addressText: string;
}): string {
  if (input.lat !== null && input.lon !== null) {
    return `https://yandex.ru/maps/?rtext=~${input.lat},${input.lon}&rtt=auto`;
  }
  return `https://yandex.ru/maps/?rtext=~${encodeURIComponent(input.addressText)}&rtt=auto`;
}
