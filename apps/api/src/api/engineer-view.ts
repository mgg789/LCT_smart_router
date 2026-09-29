import type { EngineerDayView, EngineerView } from '@lct/shared';
import { reserveDisplayName } from '../common/reserve-name';
import type { Engineer, EngineerDay } from '../generated/prisma/client';

export type { EngineerDayView, EngineerView };

/**
 * Availability, lunch and the shift of one working day.
 *
 * The three groups of state stay visibly separate: working availability is not network
 * connectivity, and neither is the progress of the work (context/32 section 5.2).
 * The shape is `@lct/shared`.
 */

export function toEngineerView(
  engineer: Engineer & { account?: { email: string } | null },
): EngineerView {
  return {
    id: engineer.id,
    version: engineer.version,
    displayName: reserveDisplayName(engineer.displayName),
    inputOrder: engineer.inputOrder,
    skills: engineer.skills,
    transportType: engineer.transportType,
    transitEligible: engineer.transitEligible,
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
