import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { Skill, TransportType } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { normalizeAddress, parseBrigades } from './dataset.parser';
import {
  DATASET_REGIONS,
  DatasetImportService,
  type DatasetRegion,
} from './dataset-import.service';
import { loadTabularGeocodes, parseTabular } from './tabular.parser';
import { TabularImportService } from './tabular-import.service';
import { type UploadDataPackageInput, UploadImportService } from './upload-import.service';

export type ReadyPackGroup = 'demo' | 'official';

export interface ReadyPackView {
  readonly id: string;
  readonly group: ReadyPackGroup;
  readonly title: string;
  readonly detail: string;
  readonly requestCount: number;
  readonly engineerCount: number;
}

export interface ReadyPackApplyResult {
  readonly id: string;
  readonly applied: boolean;
  readonly requestsCreated: number;
  readonly engineersCreated: number;
  readonly alreadyLoaded: boolean;
}

interface SamplePack {
  readonly kind: 'sample';
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly requestCount: number;
  readonly engineerCount: number;
  readonly region: DatasetRegion;
  readonly fileName: string;
}

interface OfficialPack {
  readonly kind: 'official-base' | 'official-extra';
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly requestCount: number;
  readonly engineerCount: number;
}

const SAMPLE_PACKS: readonly SamplePack[] = [
  {
    kind: 'sample',
    id: 'light-east',
    title: 'Лёгкий день, Восток',
    detail: '7 заявок и 3 бригады. Короткий первый день.',
    requestCount: 7,
    engineerCount: 3,
    region: 'east',
    fileName: '04-light-day-east-utf8.csv',
  },
  {
    kind: 'sample',
    id: 'calm-east',
    title: 'Спокойный день, Восток',
    detail: '12 заявок и 4 бригады. Обычная смена с парой аварий.',
    requestCount: 12,
    engineerCount: 4,
    region: 'east',
    fileName: '01-calm-day-east.csv',
  },
  {
    kind: 'sample',
    id: 'mkad-southeast',
    title: 'День за МКАД, Юго-восток',
    detail: '10 заявок и 4 бригады. Кашира, Домодедово и длинные плечи.',
    requestCount: 10,
    engineerCount: 4,
    region: 'southeast',
    fileName: '02-mkad-outskirts-day.tsv',
  },
  {
    kind: 'sample',
    id: 'storm-south',
    title: 'Авральный вторник, Юго-центр',
    detail: '12 заявок и 4 бригады. Половина срочные, узкие окна.',
    requestCount: 12,
    engineerCount: 4,
    region: 'south_central',
    fileName: '03-storm-tuesday-south.xlsx',
  },
];

const OFFICIAL_PACKS: readonly OfficialPack[] = [
  {
    kind: 'official-base',
    id: 'official-base',
    title: 'Базовый набор ТЗ',
    detail: 'Восток, юго-восток и юго-центр: 205 заявок и 35 бригад.',
    requestCount: 205,
    engineerCount: 35,
  },
  {
    kind: 'official-extra',
    id: 'official-extra-days',
    title: 'Дополнительные дни организатора',
    detail: 'Таблицы 28 и 29 сентября: 421 заявка поверх уже загруженных бригад.',
    requestCount: 421,
    engineerCount: 35,
  },
];

const EXTRA_FILES: readonly { readonly region: DatasetRegion; readonly fileName: string }[] = [
  { region: 'east', fileName: 'east-day-2026-09-28.csv' },
  { region: 'east', fileName: 'east-day-2026-09-29.csv' },
  { region: 'southeast', fileName: 'southeast-day-2026-09-28.csv' },
  { region: 'southeast', fileName: 'southeast-day-2026-09-29.csv' },
  { region: 'south_central', fileName: 'south_central-day-2026-09-28.csv' },
];

/**
 * Named datasets a dispatcher can drop onto the day already on screen.
 *
 * The same pack a second time adds nothing. A different pack appends.
 * Windows are placed on the running LIVE date, not on the next wall-clock morning.
 */
@Injectable()
export class ReadyPacksService {
  constructor(
    private readonly datasets: DatasetImportService,
    private readonly tabular: TabularImportService,
    private readonly uploads: UploadImportService,
  ) {}

  list(): { readonly packs: ReadyPackView[] } {
    return {
      packs: [...SAMPLE_PACKS, ...OFFICIAL_PACKS].map((pack) => ({
        id: pack.id,
        group: pack.kind === 'sample' ? 'demo' : 'official',
        title: pack.title,
        detail: pack.detail,
        requestCount: pack.requestCount,
        engineerCount: pack.engineerCount,
      })),
    };
  }

  async apply(
    context: OperationContext,
    id: string,
    datasetRoot: string,
    offsetSec: number,
  ): Promise<ReadyPackApplyResult> {
    const pack = [...SAMPLE_PACKS, ...OFFICIAL_PACKS].find((item) => item.id === id);
    if (!pack) throw SysError.notFound('Ready pack', { id });
    const workDate = await this.targetWorkDate(context, offsetSec);
    const summary = await this.applyChosen(context, pack, datasetRoot, offsetSec, workDate);
    await alignRunningDay(context);
    return {
      id: pack.id,
      applied: summary.requestsCreated > 0 || summary.engineersCreated > 0,
      requestsCreated: summary.requestsCreated,
      engineersCreated: summary.engineersCreated,
      alreadyLoaded: summary.requestsCreated === 0 && summary.engineersCreated === 0,
    };
  }

  private applyChosen(
    context: OperationContext,
    pack: SamplePack | OfficialPack,
    datasetRoot: string,
    offsetSec: number,
    workDate: string,
  ): Promise<{ requestsCreated: number; engineersCreated: number }> {
    if (pack.kind === 'official-base')
      return this.applyOfficialBase(context, datasetRoot, offsetSec);
    if (pack.kind === 'official-extra') {
      return this.applyExtraDays(context, datasetRoot, offsetSec, workDate);
    }
    if (pack.kind !== 'sample') {
      throw SysError.notFound('Ready pack', { id: pack.id });
    }
    return this.applySample(context, pack, datasetRoot, offsetSec, workDate);
  }

  private async applyOfficialBase(
    context: OperationContext,
    datasetRoot: string,
    offsetSec: number,
  ): Promise<{ requestsCreated: number; engineersCreated: number }> {
    const summary = await this.datasets.importRegions(
      context,
      DATASET_REGIONS,
      datasetRoot,
      offsetSec,
      {},
    );
    return {
      requestsCreated: summary.requestsCreated,
      engineersCreated: summary.engineersCreated,
    };
  }

  private async applySample(
    context: OperationContext,
    pack: SamplePack,
    datasetRoot: string,
    offsetSec: number,
    workDate: string,
  ): Promise<{ requestsCreated: number; engineersCreated: number }> {
    const filePath = resolve(datasetRoot, '..', '..', 'samples', pack.fileName);
    const summary = await this.applyTabularFile(context, {
      datasetRoot,
      offsetSec,
      workDate,
      region: pack.region,
      filePath,
      fileName: pack.fileName,
      sourceVersion: `ready:${pack.id}:${workDate}`,
      engineerCount: pack.engineerCount,
    });
    return summary;
  }

  private async applyExtraDays(
    context: OperationContext,
    datasetRoot: string,
    offsetSec: number,
    workDate: string,
  ): Promise<{ requestsCreated: number; engineersCreated: number }> {
    let requestsCreated = 0;
    let engineersCreated = 0;
    for (const file of EXTRA_FILES) {
      const summary = await this.applyTabularFile(context, {
        datasetRoot,
        offsetSec,
        workDate,
        region: file.region,
        filePath: resolve(datasetRoot, '..', 'extra-days', file.fileName),
        fileName: file.fileName,
        sourceVersion: `ready:extra:${file.fileName}:${workDate}`,
        engineerCount: null,
      });
      requestsCreated += summary.requestsCreated;
      engineersCreated += summary.engineersCreated;
    }
    return { requestsCreated, engineersCreated };
  }

  private async applyTabularFile(
    context: OperationContext,
    input: {
      readonly datasetRoot: string;
      readonly offsetSec: number;
      readonly workDate: string;
      readonly region: DatasetRegion;
      readonly filePath: string;
      readonly fileName: string;
      readonly sourceVersion: string;
      readonly engineerCount: number | null;
    },
  ): Promise<{ requestsCreated: number; engineersCreated: number }> {
    const bytes = readFileSync(input.filePath);
    const source = {
      fileName: input.fileName,
      payloadBase64: bytes.toString('base64'),
      encoding: 'auto' as const,
      delimiter: 'auto' as const,
    };
    const parsed = await parseTabular(source);
    const converted = await this.tabular.convert({
      source,
      options: {
        mode: 'append_requests',
        region: input.region,
        workDate: input.workDate,
        columns: parsed.columns,
        defaults: {},
        durationUnit: parsed.durationUnit,
        depot: { addressText: parsed.officeAddress ?? '' },
        engineers: {
          count: 1,
          transportType: 'car',
          skills: ['connection'],
          shiftStart: '10:00',
          shiftEnd: '22:00',
        },
        edits: [],
      },
    });
    if (!converted.file || converted.issues.length > 0) {
      throw new SysError('VALIDATION_FAILED', 'Ready pack could not be read', {
        details: {
          id: input.sourceVersion,
          issues: converted.issues.slice(0, 8),
        },
      });
    }
    const requests = converted.file.requests;
    const geocodes = loadTabularGeocodes(input.datasetRoot);
    const depotPoint =
      (parsed.officeAddress ? geocodes.get(normalizeAddress(parsed.officeAddress)) : undefined) ??
      (requests[0] ? { lat: requests[0].lat, lon: requests[0].lon } : null);
    if (!depotPoint) {
      throw new SysError('VALIDATION_FAILED', 'Ready pack has no coordinates', {
        details: { file: input.fileName },
      });
    }
    const shiftStart = Math.min(...requests.map((request) => request.windowStartAt));
    const shiftEnd = Math.max(...requests.map((request) => request.windowEndAt));
    const regionReady = await regionHasCrew(context, input.region);
    const engineers = regionReady
      ? []
      : crewsFor(
          input.datasetRoot,
          input.region,
          input.engineerCount,
          depotPoint,
          shiftStart,
          shiftEnd,
        );
    const packageInput: UploadDataPackageInput = {
      operationId: '00000000-0000-0000-0000-000000000000',
      schemaVersion: '1.0',
      mode: regionReady ? 'append_requests' : 'new_region',
      region: input.region,
      sourceVersion: input.sourceVersion,
      requests,
      ...(regionReady
        ? {}
        : {
            engineers,
            depot: {
              addressText: parsed.officeAddress ?? input.region,
              lat: depotPoint.lat,
              lon: depotPoint.lon,
            },
          }),
    };
    const summary = await this.uploads.importPackage(context, packageInput, input.offsetSec);
    return {
      requestsCreated: summary.requestsCreated,
      engineersCreated: summary.engineersCreated,
    };
  }

  private async targetWorkDate(context: OperationContext, offsetSec: number): Promise<string> {
    const day = await context.tx.liveWorkday.findFirst({
      where: { status: 'running' },
      orderBy: { startedAtWallSec: 'desc' },
      select: { workDate: true },
    });
    if (day) return day.workDate;
    return new Date((context.now + offsetSec) * 1000).toISOString().slice(0, 10);
  }
}

async function regionHasCrew(context: OperationContext, region: string): Promise<boolean> {
  const [depot, engineers] = await Promise.all([
    context.tx.depot.findUnique({ where: { region }, select: { id: true } }),
    context.tx.engineer.count({ where: { region, archivedAt: null } }),
  ]);
  return Boolean(depot) && engineers > 0;
}

function crewsFor(
  datasetRoot: string,
  region: DatasetRegion,
  engineerCount: number | null,
  depot: { lat: number; lon: number },
  shiftStartAt: number,
  shiftEndAt: number,
): UploadDataPackageInput['engineers'] {
  const controlPath = resolve(datasetRoot, `${region}_control_distribution.csv`);
  const brigades = parseBrigades(region, readFileSync(controlPath));
  const limit = engineerCount ?? brigades.length;
  return brigades.slice(0, limit).map((brigade) => {
    const crew = demoCrew(brigade.inputOrder);
    return {
      externalId: brigade.name,
      displayName: brigade.name,
      skills: crew.skills,
      transportType: crew.transportType,
      start: depot,
      shiftStartAt,
      shiftEndAt,
    };
  });
}

/** Same rotation the official importer uses when the source has no crew directory. */
function demoCrew(inputOrder: number): { skills: Skill[]; transportType: TransportType } {
  const skillSets: Skill[][] = [
    ['connection'],
    ['connection', 'emergency'],
    ['local', 'connection'],
    ['emergency'],
    ['local', 'connection', 'emergency'],
    ['local'],
  ];
  const transports: TransportType[] = ['car', 'car', 'car', 'walk', 'bike', 'transit'];
  return {
    skills: skillSets[inputOrder % skillSets.length] ?? ['connection'],
    transportType: transports[inputOrder % transports.length] ?? 'car',
  };
}

/** Pulls a just-started empty day back over the shifts that a pack just created. */
async function alignRunningDay(context: OperationContext): Promise<void> {
  const day = await context.tx.liveWorkday.findFirst({
    where: { status: 'running' },
    orderBy: { startedAtWallSec: 'desc' },
  });
  if (!day) return;
  const shifts = await context.tx.engineerDay.findMany({
    where: { workDate: day.workDate },
    select: { engineerId: true, shiftStartAt: true, shiftEndAt: true },
  });
  const real = shifts.filter(
    (shift) =>
      shift.shiftStartAt !== null &&
      shift.shiftEndAt !== null &&
      shift.shiftEndAt > shift.shiftStartAt,
  );
  if (real.length === 0) return;
  const start = Math.min(...real.map((shift) => Number(shift.shiftStartAt)));
  const end = Math.max(...real.map((shift) => Number(shift.shiftEndAt)));
  if (Number(day.logicalStartAt) !== start || Number(day.logicalEndAt) !== end) {
    await context.tx.liveWorkday.update({
      where: { id: day.id },
      data: {
        logicalStartAt: BigInt(start),
        logicalEndAt: BigInt(end),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
  }
  await context.tx.liveEngineerState.createMany({
    data: real.map((shift) => ({
      workdayId: day.id,
      engineerId: shift.engineerId,
      createdAt: BigInt(context.now),
      updatedAt: BigInt(context.now),
    })),
    skipDuplicates: true,
  });
}
