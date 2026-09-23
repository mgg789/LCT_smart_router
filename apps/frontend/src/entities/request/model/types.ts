/** Stages a request moves through (docs/frontend-api.md §5). */
export type RequestLifecycle = 'draft' | 'submitted' | 'in_progress' | 'completed' | 'cancelled';

/** `pending` means "waiting for a fresh calculation" — it is not a refusal. */
export type AssignmentState = 'pending' | 'assigned' | 'unassigned';

export type RequestPriority = 'normal' | 'urgent';
export type RequiredSkill = 'local' | 'connection' | 'emergency';
export type RequiredEquipment = 'router' | 'set_top_box' | 'smart_speaker' | null;

/**
 * One request as the dispatcher contour sees it.
 *
 * Three states must not be merged into one status: the lifecycle, the assignment
 * and the execution facts answer different questions (docs/frontend-api.md §12).
 * All absolute times are integer Unix seconds.
 */
export interface RequestView {
  id: string;
  version: number;
  lifecycle: RequestLifecycle;
  assignmentState: AssignmentState;
  addressText: string;
  region: string;
  /** Coordinates are never invented: an empty pair is diagnostics, not a pin. */
  lat: number | null;
  lon: number | null;
  needsGeocoding: boolean;
  geocodeQuality: string | null;
  /** Code of the work type; `workTypeTitle` is what a human reads. */
  workType: string;
  workTypeTitle: string;
  requiredSkill: RequiredSkill;
  requiredEquipment: RequiredEquipment;
  normProfileCode: string | null;
  normativeTravelDurationSec: number | null;
  technicalDurationSec: number | null;
  documentationDurationSec: number | null;
  serviceDurationSec: number | null;
  actualDurationSec: number | null;
  durationVarianceSec: number | null;
  windowStartAt: number;
  windowEndAt: number;
  priority: RequestPriority;
  contactName: string | null;
  problemText: string | null;
  createdAt: number;
  submittedAt: number | null;
  startedAt: number | null;
  expectedCompletionAt: number | null;
  continuationAvailableAt: number | null;
  overrunDetectedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface RequestsView {
  requests: RequestView[];
}
