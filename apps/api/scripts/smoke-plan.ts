import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const publicationSchema = z.object({
  published: z.literal(true),
  publicationId: z.string().min(1),
  publicationSeq: z.number().int().positive(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  planningAsOf: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  trigger: z.string(),
  payload: z.string().min(1),
});

/** Exact stored publication, including its working-set generation and UTF-8 bytes. */
export type SmokePublication = z.infer<typeof publicationSchema>;

const stockSchema = z
  .object({
    router: z.number().int().nonnegative(),
    set_top_box: z.number().int().nonnegative(),
    smart_speaker: z.number().int().nonnegative(),
  })
  .strict();
const taskSchema = z
  .object({
    planning_as_of: z.number().int().nonnegative(),
    engineers: z.array(
      z.object({ engineer_id: z.string().min(1), equipment_stock: stockSchema }).passthrough(),
    ),
  })
  .passthrough();

/**
 * Read publication metadata only when its hash matches the exact stored UTF-8 bytes.
 * @param value Public debug-snapshot response; unavailable or corrupt data returns null.
 * @returns A validated publication without reserializing its payload.
 */
export function readSmokePublication(value: unknown): SmokePublication | null {
  const parsed = publicationSchema.safeParse(value);
  if (!parsed.success) return null;
  const publication = parsed.data;
  return createHash('sha256').update(publication.payload, 'utf8').digest('hex') ===
    publication.inputHash
    ? publication
    : null;
}

/**
 * Recognize the automatic morning equipment issue following first plan acceptance.
 * @param previous The smoke step's original publication.
 * @param next A newer publication from the same working set.
 * @param engineerId Only this engineer's increasing stock may change.
 * @returns True only for equipment_issued with identical remaining task fields.
 */
export function followsSmokeEquipmentIssue(
  previous: SmokePublication,
  next: SmokePublication,
  engineerId: string,
): boolean {
  if (
    !readSmokePublication(previous) ||
    !readSmokePublication(next) ||
    next.trigger !== 'engineer.equipment_issued' ||
    next.generation !== previous.generation ||
    next.publicationId === previous.publicationId ||
    next.publicationSeq <= previous.publicationSeq ||
    next.planningAsOf < previous.planningAsOf
  )
    return false;

  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(previous.payload);
    after = JSON.parse(next.payload);
  } catch {
    return false;
  }
  const original = taskSchema.safeParse(before);
  const issued = taskSchema.safeParse(after);
  if (!original.success || !issued.success) return false;
  if (
    original.data.planning_as_of !== previous.planningAsOf ||
    issued.data.planning_as_of !== next.planningAsOf
  )
    return false;
  const oldStock = original.data.engineers.find(
    (item) => item.engineer_id === engineerId,
  )?.equipment_stock;
  const newStock = issued.data.engineers.find(
    (item) => item.engineer_id === engineerId,
  )?.equipment_stock;
  if (!oldStock || !newStock || isDeepStrictEqual(oldStock, newStock)) return false;
  for (const kind of ['router', 'set_top_box', 'smart_speaker'] as const) {
    if (newStock[kind] < oldStock[kind]) return false;
  }

  const stableTask = (task: z.infer<typeof taskSchema>) => {
    const { planning_as_of: _planningAsOf, engineers, ...rest } = task;
    return {
      ...rest,
      engineers: engineers.map((engineer) => {
        if (engineer.engineer_id !== engineerId) return engineer;
        const { equipment_stock: _stock, ...profile } = engineer;
        return profile;
      }),
    };
  };
  return isDeepStrictEqual(stableTask(original.data), stableTask(issued.data));
}

/** Public plan fields needed to prove that a specific Router publication was applied. */
export interface SmokePlanResponse {
  readonly mode?: string;
  readonly plan?: {
    readonly revision: number;
    readonly origin: string;
    readonly planAsOf: number;
    readonly assignments: ReadonlyArray<{
      readonly requestId: string;
      readonly status: string;
      readonly engineerId: string | null;
    }>;
  } | null;
  readonly appliedResult?: { readonly resultId: string; readonly inputHash: string } | null;
  /** Diagnostics may refer to another package received within the same epoch second. */
  readonly lastResult?: {
    readonly resultId: string;
    readonly accepted: boolean;
    readonly rejectionCode: string | null;
  } | null;
}

/** Expected task identity and monotonic revisions for one asynchronous smoke step. */
export interface ExpectedSmokePlan {
  readonly requestIds: readonly string[];
  readonly engineerId: string;
  readonly inputHash: string;
  readonly minRevision?: number;
  readonly previousResultId?: string;
}

/**
 * Match the applied result relation, never the separately ordered last diagnostic.
 * The input hash binds the result to this publication; all requests must actually
 * be assigned to the expected engineer and optional revision/result bounds must advance.
 */
export function matchesSmokePlan(plan: SmokePlanResponse, expected: ExpectedSmokePlan): boolean {
  const applied = plan.appliedResult;
  if (
    plan.mode !== 'auto' ||
    plan.plan?.origin !== 'auto' ||
    !applied?.resultId ||
    applied.inputHash !== expected.inputHash ||
    (expected.previousResultId !== undefined && applied.resultId === expected.previousResultId) ||
    (expected.minRevision !== undefined && plan.plan.revision <= expected.minRevision)
  )
    return false;
  const byRequest = new Map(plan.plan.assignments.map((item) => [item.requestId, item]));
  return expected.requestIds.every((requestId) => {
    const assignment = byRequest.get(requestId);
    return assignment?.status === 'assigned' && assignment.engineerId === expected.engineerId;
  });
}
