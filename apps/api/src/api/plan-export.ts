import type { PlanView, RequestView } from '@lct/shared';
import ExcelJS from 'exceljs';
import { configuredTimeZone } from '../common/time/zone';

export interface ExportRequest {
  readonly view: RequestView;
  readonly clientEmail: string | null;
  readonly passport: {
    readonly connectionType: string;
    readonly difficulty: number;
    readonly equipment: string | null;
    readonly accessNotes: string | null;
    readonly comment: string | null;
  } | null;
}

export interface PlanExportData {
  readonly plan: PlanView;
  readonly engineerNames: ReadonlyMap<string, string>;
  readonly requests: ReadonlyMap<string, ExportRequest>;
}

const time = new Intl.DateTimeFormat('ru-RU', {
  timeZone: configuredTimeZone(),
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function at(value: number | null | undefined): string {
  return value == null ? '' : time.format(new Date(value * 1000));
}

function duration(seconds: number | null | undefined): string {
  return seconds == null ? '' : String(Math.round(seconds / 60));
}

function assignmentStatus(status: PlanView['assignments'][number]['status']): string {
  switch (status) {
    case 'assigned':
      return 'Назначена';
    case 'in_progress':
      return 'В работе';
    case 'done':
      return 'Выполнена';
    case 'pending':
      return 'Ожидает';
    case 'unassigned':
      return 'Не назначена';
  }
}

/** Render the immutable applied revision as two Excel sheets; no live state is recomputed. */
export async function renderPlanWorkbook(data: PlanExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Navix';
  const schedule = workbook.addWorksheet('План по инженерам', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  schedule.addRow([
    'Инженер',
    'Порядок',
    'Заявка',
    'Адрес',
    'Прибытие (МСК)',
    'Начало (МСК)',
    'Окончание (МСК)',
  ]);
  const routes = [...data.plan.routes].sort((a, b) =>
    (data.engineerNames.get(a.engineerId) ?? a.engineerId).localeCompare(
      data.engineerNames.get(b.engineerId) ?? b.engineerId,
      'ru',
    ),
  );
  for (const route of routes) {
    const name = data.engineerNames.get(route.engineerId) ?? route.engineerId;
    for (const stop of route.stops) {
      if (stop.kind !== 'job' || !stop.requestId) continue;
      schedule.addRow([
        name,
        stop.sequence,
        stop.requestId,
        data.requests.get(stop.requestId)?.view.addressText ?? '',
        at(stop.arrivalAt),
        at(stop.startAt),
        at(stop.endAt),
      ]);
    }
  }

  const details = workbook.addWorksheet('Все заявки', { views: [{ state: 'frozen', ySplit: 1 }] });
  details.addRow([
    'Инженер',
    'Статус плана',
    'Заявка',
    'Тип работы',
    'Адрес',
    'Норматив работы, мин',
    'Окно от (МСК)',
    'Окно до (МСК)',
    'Плановое прибытие (МСК)',
    'Плановое начало (МСК)',
    'Клиент',
    'Email клиента',
    'Паспорт: подключение',
    'Паспорт: сложность',
    'Паспорт: оборудование',
    'Паспорт: доступ',
    'Паспорт: комментарий',
  ]);
  const stops = new Map(
    routes.flatMap((route) =>
      route.stops.flatMap((stop) =>
        stop.kind === 'job' && stop.requestId ? [[stop.requestId, stop] as const] : [],
      ),
    ),
  );
  for (const assignment of [...data.plan.assignments].sort(
    (a, b) =>
      Number(a.engineerId === null) - Number(b.engineerId === null) ||
      (data.engineerNames.get(a.engineerId ?? '') ?? '').localeCompare(
        data.engineerNames.get(b.engineerId ?? '') ?? '',
        'ru',
      ) ||
      a.requestId.localeCompare(b.requestId),
  )) {
    const request = data.requests.get(assignment.requestId);
    const stop = stops.get(assignment.requestId);
    details.addRow([
      assignment.engineerId
        ? (data.engineerNames.get(assignment.engineerId) ?? assignment.engineerId)
        : 'Не назначен',
      assignmentStatus(assignment.status),
      assignment.requestId,
      request?.view.workTypeTitle ?? request?.view.workType ?? '',
      request?.view.addressText ?? '',
      duration(request?.view.serviceDurationSec),
      at(request?.view.windowStartAt),
      at(request?.view.windowEndAt),
      at(stop?.arrivalAt),
      at(stop?.startAt),
      request?.view.contactName ?? '',
      request?.clientEmail ?? '',
      request?.passport?.connectionType ?? '',
      request?.passport?.difficulty ?? '',
      request?.passport?.equipment ?? '',
      request?.passport?.accessNotes ?? '',
      request?.passport?.comment ?? '',
    ]);
  }
  for (const sheet of [schedule, details]) {
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = {
      from: 'A1',
      to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
    };
    sheet.columns.forEach((column) => {
      column.width = 24;
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
