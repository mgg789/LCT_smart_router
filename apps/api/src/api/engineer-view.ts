import type { Engineer, EngineerDay } from '../generated/prisma/client';

export interface EngineerView {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly inputOrder: number;
  readonly skills: string[];
  readonly transportType: string;
  readonly region: string | null;
  readonly homeLat: number | null;
  readonly homeLon: number | null;
  readonly hasAccount: boolean;
  /** The login address, when the profile has one linked; null on imported brigades. */
  readonly email: string | null;
}

/**
 * Availability, lunch and the shift of one working day.
 *
 * The three groups of state stay visibly separate: working availability is not network
 * connectivity, and neither is the progress of the work (context/32 section 5.2).
 */
export interface EngineerDayView {
  readonly engineerId: string;
  readonly workDate: string;
  readonly version: number;
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
  readonly availability: string;
  readonly expectedOnlineAt: number | null;
  readonly attendanceOptOut: boolean;
  readonly lastAttendanceAt: number | null;
  readonly attendanceGraceUntil: number | null;
  readonly equipmentStock: {
    readonly router: number;
    readonly setTopBox: number;
    readonly smartSpeaker: number;
  };
  readonly equipmentIssuedAt: number | null;
  readonly lunch: {
    readonly enabled: boolean;
    readonly durationSec: number | null;
    readonly windowStartAt: number | null;
    readonly windowEndAt: number | null;
    readonly required: boolean;
    /** The single lunch of the day has been used. Not a statement that it has finished. */
    readonly taken: boolean;
    readonly startedAt: number | null;
  };
}

export function toEngineerView(
  engineer: Engineer & { account?: { email: string } | null },
): EngineerView {
  return {
    id: engineer.id,
    version: engineer.version,
    displayName: engineer.displayName,
    inputOrder: engineer.inputOrder,
    skills: engineer.skills,
    transportType: engineer.transportType,
    region: engineer.region,
    homeLat: engineer.homeLat,
    homeLon: engineer.homeLon,
    // A routing profile can exist without a login: the dispatcher may have imported the
    // engineer before an address was known (context/37 section 3.1).
    hasAccount: engineer.accountId !== null,
    email: engineer.account?.email ?? null,
  };
}

export function toDayView(day: EngineerDay): EngineerDayView {
  return {
    engineerId: day.engineerId,
    workDate: day.workDate,
    version: day.version,
    shiftStartAt: Number(day.shiftStartAt),
    shiftEndAt: Number(day.shiftEndAt),
    availability: day.availability,
    expectedOnlineAt: nullableNumber(day.expectedOnlineAt),
    attendanceOptOut: day.attendanceOptOut,
    lastAttendanceAt: nullableNumber(day.lastAttendanceAt),
    attendanceGraceUntil: nullableNumber(day.attendanceGraceUntil),
    equipmentStock: {
      router: day.equipmentRouter,
      setTopBox: day.equipmentSetTopBox,
      smartSpeaker: day.equipmentSmartSpeaker,
    },
    equipmentIssuedAt: nullableNumber(day.equipmentIssuedAt),
    lunch: {
      enabled: day.lunchEnabled,
      durationSec: day.lunchDurationSec,
      windowStartAt: nullableNumber(day.lunchWindowStartAt),
      windowEndAt: nullableNumber(day.lunchWindowEndAt),
      required: day.lunchRequired,
      taken: day.lunchTaken,
      startedAt: nullableNumber(day.lunchStartedAt),
    },
  };
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
