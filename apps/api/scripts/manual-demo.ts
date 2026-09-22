import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type UploadDataPackageDto, uploadDataPackageSchema } from '../src/api/dto/data.dto';
import { workDateOf } from '../src/orchestrator/engineers/workday';

/** Creates the reproducible 4/2 file for a Moscow work date; never imports or resets data. */
export function buildManualDemo(workDate: string): Omit<UploadDataPackageDto, 'operationId'> {
  const start = Date.parse(`${workDate}T09:00:00+03:00`) / 1000;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(workDate) ||
    !Number.isFinite(start) ||
    workDateOf(start, 'Europe/Moscow') !== workDate
  )
    throw new Error('Expected a valid Moscow work date in YYYY-MM-DD format');
  let root = __dirname;
  while (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot locate the LCT workspace');
    root = parent;
  }
  const fixture = uploadDataPackageSchema.parse({
    ...JSON.parse(readFileSync(resolve(root, 'data/demo/manual-control.json'), 'utf8')),
    operationId: randomUUID(),
  });
  const first = fixture.engineers?.[0];
  if (!first) throw new Error('The manual fixture has no engineer');
  const delta = start - first.shiftStartAt;
  const { operationId: _operationId, ...file } = fixture;
  return {
    ...file,
    sourceVersion: `${file.sourceVersion}-${workDate}`,
    engineers: fixture.engineers?.map((engineer) => ({
      ...engineer,
      shiftStartAt: engineer.shiftStartAt + delta,
      shiftEndAt: engineer.shiftEndAt + delta,
    })),
    requests: fixture.requests.map((request) => ({
      ...request,
      windowStartAt: request.windowStartAt + delta,
      windowEndAt: request.windowEndAt + delta,
    })),
  };
}

if (require.main === module) {
  const date = process.argv[2] ?? workDateOf(Math.floor(Date.now() / 1000), 'Europe/Moscow');
  try {
    console.log(JSON.stringify(buildManualDemo(date), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Manual demo generation failed');
    process.exitCode = 1;
  }
}
