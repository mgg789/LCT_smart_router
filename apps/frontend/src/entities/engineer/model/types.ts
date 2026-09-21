import type { RequiredSkill } from '@/entities/request';

export type TransportType = 'car' | 'walk' | 'bike' | 'transit';
export type Availability = 'online' | 'offline';

export interface EngineerLunch {
  enabled: boolean;
  durationSec: number | null;
  windowStartAt: number | null;
  windowEndAt: number | null;
  required: boolean;
  /** Set by sys when the lunch actually starts — there is no second lunch. */
  taken: boolean;
  startedAt: number | null;
}

export interface EngineerDayView {
  engineerId: string;
  /** Local date `YYYY-MM-DD`; everything else here is Unix seconds. */
  workDate: string;
  version: number;
  shiftStartAt: number;
  shiftEndAt: number;
  availability: Availability;
  expectedOnlineAt: number | null;
  equipmentStock: Record<string, number>;
  equipmentIssuedAt: number | null;
  lunch: EngineerLunch;
}

/**
 * A crew. The case counts a crew as one person, so this is what the UI calls an
 * engineer. Profile, availability and work progress are three different things
 * and are not merged into one status (docs/frontend-api.md §6.2).
 */
export interface EngineerView {
  id: string;
  version: number;
  displayName: string;
  inputOrder: number;
  skills: RequiredSkill[];
  transportType: TransportType;
  region: string;
  homeLat: number | null;
  homeLon: number | null;
  hasAccount: boolean;
  email: string | null;
  /** Last known working day; `null` when none has been set. */
  day: EngineerDayView | null;
}

export interface EngineersView {
  engineers: EngineerView[];
}
