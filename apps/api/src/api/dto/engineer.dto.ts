import { z } from 'zod';
import { operationEnvelopeSchema } from './request.dto';

const unixSeconds = z.number().int().nonnegative();
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/** One to three distinct skills; a request requires exactly one (context/33 section 4). */
const skills = z
  .array(z.enum(['local', 'connection', 'emergency']))
  .min(1)
  .max(3);

const transportType = z.enum(['car', 'walk', 'bike', 'transit']);

/** For actions that carry no arguments beyond the intention itself, on the caller's own
 * engineer. An integration key instead extends the body with `engineerId`
 * (context/41 section 3.2). */
export const operationOnlySchema = z.object({ operationId: z.uuid() });

/** Same as [[operationOnlySchema]], but an integration key names the engineer object. */
export const engineerActionSchema = operationOnlySchema.extend({
  /** Required for an integration key, refused for a session (the subject is the session's
   * own engineer, context/42 DF-06). */
  engineerId: z.string().min(1).optional(),
});
export type EngineerActionDto = z.infer<typeof engineerActionSchema>;

export const createEngineerSchema = operationEnvelopeSchema.extend({
  /** A routing profile may be created before access to the Engineer App is granted. */
  email: z.email().nullish(),
  displayName: z.string().min(1).max(200),
  /**
   * Required at creation: adding an address creates the access, but an engineer Router
   * can plan for needs real skills, transport and a start point, and those are never
   * filled with invented values (context/42 DF-03).
   */
  skills,
  transportType,
  region: z.string().max(120).nullish(),
  homeLat: latitude.nullish(),
  homeLon: longitude.nullish(),
});
export type CreateEngineerDto = z.infer<typeof createEngineerSchema>;

/** Reversible profile removal. Historical plans and facts keep their engineer id. */
export const archiveEngineerSchema = operationEnvelopeSchema;
export type ArchiveEngineerDto = z.infer<typeof archiveEngineerSchema>;

/**
 * Links a login address to an engineer profile that exists without one, such as a brigade
 * that arrived with an import (context/37 section 3.1). The dispatcher grants the access;
 * typing the address on the sign-in screen never creates it. The profile is named in the
 * body, like the plan/reassign actions do.
 */
export const linkEngineerAccountSchema = operationEnvelopeSchema.extend({
  engineerId: z.string().min(1),
  email: z.email(),
});
export type LinkEngineerAccountDto = z.infer<typeof linkEngineerAccountSchema>;

/**
 * Removes the login the dispatcher previously granted. The routing profile stays;
 * only the address, the engineer role and live engineer sessions are taken away.
 */
export const unlinkEngineerAccountSchema = operationEnvelopeSchema.extend({
  engineerId: z.string().min(1),
});
export type UnlinkEngineerAccountDto = z.infer<typeof unlinkEngineerAccountSchema>;

export const updateEngineerSchema = operationEnvelopeSchema.extend({
  displayName: z.string().min(1).max(200).optional(),
  skills: skills.optional(),
  transportType: transportType.optional(),
  region: z.string().max(120).nullish(),
  homeLat: latitude.nullish(),
  homeLon: longitude.nullish(),
});
export type UpdateEngineerDto = z.infer<typeof updateEngineerSchema>;

/** The engineer's own edit. Region is not here: it is not theirs to choose. An
 * integration key adds `engineerId` to name the profile it edits. */
export const updateOwnProfileSchema = operationEnvelopeSchema.extend({
  /** Required for an integration key, refused for a session (context/41 section 3.2). */
  engineerId: z.string().min(1).optional(),
  displayName: z.string().min(1).max(200).optional(),
  skills: skills.optional(),
  transportType: transportType.optional(),
  homeLat: latitude.nullish(),
  homeLon: longitude.nullish(),
});
export type UpdateOwnProfileDto = z.infer<typeof updateOwnProfileSchema>;

export const requestEmailChangeSchema = z.object({
  email: z.email(),
});
export type RequestEmailChangeDto = z.infer<typeof requestEmailChangeSchema>;

export const confirmEmailChangeSchema = z.object({
  email: z.email(),
  code: z.string().regex(/^\d{6}$/, 'The code is six digits'),
});
export type ConfirmEmailChangeDto = z.infer<typeof confirmEmailChangeSchema>;

export const setAvailabilitySchema = operationEnvelopeSchema.extend({
  /** Required for an integration key, refused for a session (context/41 section 3.2). */
  engineerId: z.string().min(1).optional(),
  availability: z.enum(['online', 'offline']),
  /**
   * Expected return from a technical stop. A forecast only: reaching this moment creates
   * no online fact (context/33 section 5).
   */
  expectedOnlineAt: unixSeconds.nullish(),
});
export type SetAvailabilityDto = z.infer<typeof setAvailabilitySchema>;

export const setWorkdaySchema = operationEnvelopeSchema.extend({
  /** Local calendar day as `YYYY-MM-DD`. */
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftStartAt: unixSeconds,
  shiftEndAt: unixSeconds,
  /**
   * Lunch conditions. Enabling it requires a duration and both window bounds: the hours
   * and the length were never agreed, and a feature that is switched on must not run on
   * an invented norm (context/32 section 8).
   */
  lunch: z
    .object({
      enabled: z.boolean(),
      durationSec: z.number().int().positive().nullish(),
      windowStartAt: unixSeconds.nullish(),
      windowEndAt: unixSeconds.nullish(),
    })
    .optional(),
  /** Set by the dispatcher's explicit "restore lunch" decision, not by ordinary planning. */
  lunchRequired: z.boolean().optional(),
  /** Day-specific opt-out from silence monitoring; it never changes routing availability. */
  attendanceOptOut: z.boolean().optional(),
});
export type SetWorkdayDto = z.infer<typeof setWorkdaySchema>;
