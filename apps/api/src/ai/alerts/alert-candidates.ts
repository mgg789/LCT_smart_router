import type { Engineer, EngineerDay, Request } from '../../generated/prisma/client';

/**
 * The `add_engineer` candidate filter, moved server-side.
 *
 * Ported from `apps/web/src/components/AlertsPage.tsx` (the `additionalEngineers` filter
 * around line 173): offline, skill match, region match. It used to run in the browser,
 * where a dispatcher picked from it by hand; here it is the *validated* list the resolver
 * schema narrows `engineerId` to, so the model chooses from a server-computed catalogue
 * instead of naming an engineer that was never actually eligible.
 */
export interface AddEngineerCandidate {
  readonly engineerId: string;
  readonly displayName: string;
  readonly region: string | null;
  readonly skills: readonly string[];
}

export function addEngineerCandidates(
  alertEngineerIds: readonly string[],
  request: Request | null,
  engineers: ReadonlyArray<Engineer & { days: EngineerDay[] }>,
): AddEngineerCandidate[] {
  return engineers
    .filter((engineer) => {
      if (alertEngineerIds.includes(engineer.id)) {
        return false;
      }
      const day = engineer.days[0];
      if (day?.availability !== 'offline') {
        return false;
      }
      if (request && !engineer.skills.includes(request.requiredSkill)) {
        return false;
      }
      if (request?.region && engineer.region !== request.region) {
        return false;
      }
      return true;
    })
    .map((engineer) => ({
      engineerId: engineer.id,
      displayName: engineer.displayName,
      region: engineer.region,
      skills: engineer.skills,
    }));
}
