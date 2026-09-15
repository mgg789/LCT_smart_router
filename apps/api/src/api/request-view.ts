import type { Request } from '../generated/prisma/client';
import { findWorkType } from '../orchestrator/requests';

/**
 * What a caller is shown about a request.
 *
 * Deliberately not the stored row: an interface does not need the whole internal object
 * to draw one card (context/36 section 11). Every `bigint` is converted here, which is
 * also the only place that conversion is allowed to happen.
 */
export interface RequestView {
  readonly id: string;
  readonly version: number;
  readonly lifecycle: string;
  readonly assignmentState: string;
  readonly addressText: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly needsGeocoding: boolean;
  readonly workType: string | null;
  readonly workTypeTitle: string | null;
  readonly requiredSkill: string;
  readonly serviceDurationSec: number;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: string;
  readonly contactName: string | null;
  readonly problemText: string | null;
  readonly createdAt: number;
  readonly submittedAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly cancelledAt: number | null;
}

export function toRequestView(request: Request): RequestView {
  const workType = request.workTypeHd === null ? null : findWorkType(request.workTypeHd);
  return {
    id: request.id,
    // Returned so the caller can send it back as `expectedVersion` on its next change.
    version: request.version,
    // Three separate facts, never merged into one status (context/36 section 3).
    lifecycle: request.lifecycle,
    assignmentState: request.assignmentState,
    addressText: request.addressText,
    lat: request.lat,
    lon: request.lon,
    needsGeocoding: request.needsGeocoding,
    workType: request.workTypeHd,
    workTypeTitle: workType?.title ?? null,
    requiredSkill: request.requiredSkill,
    serviceDurationSec: request.serviceDurationSec,
    windowStartAt: Number(request.windowStartAt),
    windowEndAt: Number(request.windowEndAt),
    priority: request.priority,
    contactName: request.contactName,
    problemText: request.problemText,
    createdAt: Number(request.createdAt),
    submittedAt: nullableNumber(request.submittedAt),
    startedAt: nullableNumber(request.startedAt),
    completedAt: nullableNumber(request.completedAt),
    cancelledAt: nullableNumber(request.cancelledAt),
  };
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
