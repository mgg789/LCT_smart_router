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
  readonly region: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly needsGeocoding: boolean;
  readonly workType: string | null;
  readonly workTypeTitle: string | null;
  readonly requiredSkill: string;
  readonly requiredEquipment: string | null;
  /** Quality marker from the prepared offline coordinate package, when known. */
  readonly geocodeQuality: string | null;
  readonly normProfileCode: string;
  readonly normativeTravelDurationSec: number;
  readonly technicalDurationSec: number;
  readonly documentationDurationSec: number;
  readonly serviceDurationSec: number;
  readonly actualDurationSec: number | null;
  readonly durationVarianceSec: number | null;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: string;
  readonly contactName: string | null;
  readonly problemText: string | null;
  readonly createdAt: number;
  readonly submittedAt: number | null;
  readonly startedAt: number | null;
  readonly expectedCompletionAt: number | null;
  readonly continuationAvailableAt: number | null;
  readonly overrunDetectedAt: number | null;
  readonly completedAt: number | null;
  readonly cancelledAt: number | null;
}

export function toRequestView(request: Request): RequestView {
  const workType = request.workTypeHd === null ? null : findWorkType(request.workTypeHd);
  const actualDurationSec = actualDuration(request.startedAt, request.completedAt);
  return {
    id: request.id,
    // Returned so the caller can send it back as `expectedVersion` on its next change.
    version: request.version,
    // Three separate facts, never merged into one status (context/36 section 3).
    lifecycle: request.lifecycle,
    assignmentState: request.assignmentState,
    addressText: request.addressText,
    region: request.region,
    lat: request.lat,
    lon: request.lon,
    needsGeocoding: request.needsGeocoding,
    workType: request.workTypeHd,
    workTypeTitle: workType?.title ?? null,
    requiredSkill: request.requiredSkill,
    requiredEquipment: request.requiredEquipment,
    geocodeQuality: geocodeQualityOf(request.origin, request.region),
    normProfileCode: request.normProfileCode,
    normativeTravelDurationSec: request.normativeTravelDurationSec,
    technicalDurationSec: request.technicalDurationSec,
    documentationDurationSec: request.documentationDurationSec,
    serviceDurationSec: request.serviceDurationSec,
    actualDurationSec,
    durationVarianceSec:
      actualDurationSec === null ? null : actualDurationSec - request.serviceDurationSec,
    windowStartAt: Number(request.windowStartAt),
    windowEndAt: Number(request.windowEndAt),
    priority: request.priority,
    contactName: request.contactName,
    problemText: request.problemText,
    createdAt: Number(request.createdAt),
    submittedAt: nullableNumber(request.submittedAt),
    startedAt: nullableNumber(request.startedAt),
    expectedCompletionAt: nullableNumber(request.expectedCompletionAt),
    continuationAvailableAt: nullableNumber(request.continuationAvailableAt),
    overrunDetectedAt: nullableNumber(request.overrunDetectedAt),
    completedAt: nullableNumber(request.completedAt),
    cancelledAt: nullableNumber(request.cancelledAt),
  };
}

function geocodeQualityOf(origin: string, region: string | null): string | null {
  if (origin !== 'import') {
    return null;
  }
  return region === 'east' ? 'address_match' : 'district_centroid_projection';
}

/** Returns confirmed on-site duration only when both engineer facts are present. */
function actualDuration(startedAt: bigint | null, completedAt: bigint | null): number | null {
  return startedAt === null || completedAt === null ? null : Number(completedAt - startedAt);
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
