import { workDateOf } from '../src/orchestrator/engineers/workday';
import { buildManualDemo } from './manual-demo';

/** Rebase four official East points onto a Moscow date, using one car engineer. No DB writes. */
export function buildMapsDemo(workDate: string) {
  const source = buildManualDemo(workDate);
  const endAt = Date.parse(`${workDate}T21:00:00+03:00`) / 1000;
  return {
    ...source,
    region: 'maps_demo',
    sourceVersion: `dro101-v1-${workDate}`,
    engineers: source.engineers?.slice(0, 1).map((engineer) => ({
      ...engineer,
      displayName: '2ГИС — Анна',
      shiftEndAt: endAt,
    })),
    requests: source.requests.map((request) => ({ ...request, windowEndAt: endAt })),
  };
}

if (require.main === module) {
  const date = process.argv[2] ?? workDateOf(Math.floor(Date.now() / 1000), 'Europe/Moscow');
  console.log(JSON.stringify(buildMapsDemo(date), null, 2));
}
