import type { EngineerView } from '../api/types';
import { TRANSPORT_OPTIONS } from '../figma-dashboard/addEntity';

/** Draft of the engineer settings form (name, login email, transport). */
export interface EngineerSettingsDraft {
  displayName: string;
  email: string;
  transportType: string;
}

/** Same checks as the dispatcher add-engineer fields that this screen reuses. */
export function validateEngineerSettings(draft: EngineerSettingsDraft): string | null {
  if (!draft.displayName.trim()) return 'Укажите имя';
  if (!TRANSPORT_OPTIONS.some((item) => item.id === draft.transportType)) {
    return 'Выберите транспорт';
  }
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    return 'Проверьте адрес почты';
  }
  return null;
}

/** True when the form email differs from the profile / session address. */
export function emailChangePending(currentEmail: string | null, draftEmail: string): boolean {
  return draftEmail.trim() !== (currentEmail ?? '').trim();
}

/**
 * Applies a valid draft onto a profile for the design-preview contour.
 * Live save uses PATCH /engineer/profile (name + transport only — email is not in that contract).
 */
export function profileFromSettings(
  current: EngineerView,
  draft: EngineerSettingsDraft,
): EngineerView {
  const transport = TRANSPORT_OPTIONS.find((item) => item.id === draft.transportType);
  return {
    ...current,
    displayName: draft.displayName.trim(),
    email: draft.email.trim() ? draft.email.trim() : current.email,
    transportType: transport?.id ?? current.transportType,
    version: current.version + 1,
  };
}
