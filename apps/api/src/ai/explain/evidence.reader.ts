import { Injectable, Logger } from '@nestjs/common';
import { type PlanEvidence, planEvidenceSchema, type RequestEvidence } from './evidence.schema';

export interface RequestEvidencePair {
  readonly main: RequestEvidence | null;
  readonly baseline: RequestEvidence | null;
}

/**
 * Typed reader over the evidence package `RouterResult.payload` already carries whole
 * (`main_evidence` / `baseline_evidence`, kept by the `looseObject` in
 * `src/routing/router-gateway/result.types.ts`).
 *
 * Every read here is honest about absence: a result computed before evidence existed, a
 * baseline that was never requested, or a package that fails validation all produce `null`
 * for that half -- never a fabricated `RequestEvidence`. This is the one place that
 * distinction is made, so `explain.service.ts` and `DispatchController`'s evidence
 * endpoint never have to re-derive it.
 */
@Injectable()
export class EvidenceReader {
  private readonly logger = new Logger(EvidenceReader.name);

  /** Parses one half (`main` or `baseline`) of the evidence package out of a stored
   *  `RouterResult.payload`. `null` when the field is absent, not an object, or fails
   *  validation -- a malformed blob is logged and treated as "no evidence", never thrown
   *  through to a dashboard read. */
  planEvidence(payload: unknown, which: 'main' | 'baseline'): PlanEvidence | null {
    const key = which === 'main' ? 'main_evidence' : 'baseline_evidence';
    if (payload === null || typeof payload !== 'object') {
      return null;
    }
    const raw = (payload as Record<string, unknown>)[key];
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = planEvidenceSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `Stored ${key} failed validation and is being treated as absent: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  }

  /** The full `candidates[]` and facts for one request, from both the main and (when
   *  present) baseline packages. Neither side is required: a result that never carried
   *  evidence, or one whose baseline was skipped, returns `null` for that half honestly. */
  forRequest(payload: unknown, requestId: string): RequestEvidencePair {
    const main = this.planEvidence(payload, 'main');
    const baseline = this.planEvidence(payload, 'baseline');
    return {
      main: main?.requests.find((item) => item.request_id === requestId) ?? null,
      baseline: baseline?.requests.find((item) => item.request_id === requestId) ?? null,
    };
  }

  /** Every request entry of the main package for one engineer's assigned stops -- used to
   *  explain a whole route, not just one request. */
  forEngineerRoute(payload: unknown, engineerId: string): RequestEvidence[] {
    const main = this.planEvidence(payload, 'main');
    return main?.requests.filter((item) => item.engineer_id === engineerId) ?? [];
  }
}
