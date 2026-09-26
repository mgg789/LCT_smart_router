import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { MonthlyReportData } from './monthly-report.types';

const INK = '#272930';
const YELLOW = '#FFCA28';
const MUTED = '#77797F';
const PAPER = '#F1F1F1';
const fmt = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Renders frozen facts into a paginated, offline Cyrillic PDF suitable for email. */
export async function renderMonthlyReport(report: MonthlyReportData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: {
      Title: `NAVIX - Итоги ${report.month}`,
      Author: 'NAVIX',
      Subject: 'Работа команды и вклад инженеров',
    },
  });
  doc.registerFont('regular', readFileSync(join(__dirname, 'assets/report-regular.ttf')));
  doc.registerFont('bold', readFileSync(join(__dirname, 'assets/report-bold.ttf')));
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const width = doc.page.width - 84;
  const text = (
    value: string,
    x: number,
    y: number,
    size = 11,
    color = INK,
    bold = false,
    boxWidth = width,
  ) => {
    doc
      .font(bold ? 'bold' : 'regular')
      .fontSize(size)
      .fillColor(color)
      .text(value, x, y, { width: boxWidth, lineGap: 3 });
  };
  const page = (title: string, eyebrow: string) => {
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(PAPER);
    doc.rect(0, 0, doc.page.width, 8).fill(YELLOW);
    text('NAVIX', 42, 32, 17, INK, true);
    text(report.month, 420, 37, 10, MUTED, false, 130);
    text(eyebrow.toUpperCase(), 42, 86, 9, MUTED, true);
    text(title, 42, 108, 28, INK, true);
  };
  const next = (title: string, eyebrow: string) => {
    doc.addPage();
    page(title, eyebrow);
  };
  const metric = (x: number, y: number, value: string, label: string, dark = false) => {
    doc.roundedRect(x, y, (width - 14) / 2, 112, 15).fill(dark ? INK : '#FFFFFF');
    text(value, x + 18, y + 16, 32, dark ? YELLOW : INK, true, 210);
    text(label, x + 18, y + 67, 10, dark ? '#D5D5D5' : MUTED, false, 210);
  };
  page('Месяц в движении', report.provisional ? 'Предварительный отчёт' : 'Итоги команды');
  text('Точнее отметки. Надёжнее прогноз. Сильнее команда.', 42, 153, 11, MUTED);
  const mix = [
    { value: report.totals.completed, color: YELLOW, label: 'подтверждено' },
    { value: report.totals.assumedCompleted, color: '#C8C8C8', label: 'по расписанию' },
    { value: report.totals.cancelled, color: INK, label: 'отменено' },
  ];
  const mixTotal = Math.max(
    1,
    mix.reduce((sum, part) => sum + Math.max(0, part.value), 0),
  );
  metric(42, 203, fmt(report.totals.completed), 'Задач с подтверждённым выполнением', true);
  metric(
    42 + (width + 14) / 2,
    203,
    fmt(report.totals.earnedPoints),
    'Баллов за полезные действия',
  );
  metric(42, 329, fmt(report.totals.engineerCount), 'Инженеров в сравнении');
  metric(
    42 + (width + 14) / 2,
    329,
    report.totals.teamAverage === null ? '—' : fmt(report.totals.teamAverage),
    'Средний итоговый балл команды',
    true,
  );
  text('Состав месяца', 42, 458, 12, INK, true);
  let mixX = 42;
  doc.roundedRect(42, 480, width, 14, 7).fill('#FFFFFF');
  for (const part of mix) {
    const partWidth = (width * Math.max(0, part.value)) / mixTotal;
    if (partWidth > 0) doc.rect(mixX, 480, partWidth, 14).fill(part.color);
    mixX += partWidth;
  }
  text(mix.map((part) => `${part.label} ${fmt(part.value)}`).join('   ·   '), 42, 500, 9, MUTED);
  text('За цифрами стоят действия', 42, 528, 18, INK, true);
  text(
    `Подтверждено работы: ${fmt(report.totals.workMinutes / 60)} ч.\nОтменено заявок: ${fmt(report.totals.cancelled)}.\nПрошло по расписанию без подтверждения: ${fmt(report.totals.assumedCompleted)}.\nРучные корректировки за нарушения: ${fmt(report.totals.penaltyPoints)} баллов.`,
    42,
    560,
    12,
  );
  text(
    'Автоматические предположения не считаются подтверждённой работой и не приносят баллов. Итог инженера сравнивается со средним команды за тот же месяц.',
    42,
    700,
    10,
    MUTED,
  );

  next('Вклад каждого', 'Инженеры / баллы / команда');
  text(
    '1,00× — средний балл команды. Начисления и нарушения показаны отдельно.',
    42,
    155,
    10,
    MUTED,
  );
  let y = 202;
  const max = Math.max(1, ...report.engineers.map((row) => Math.max(0, row.points)));
  for (const [index, row] of report.engineers.entries()) {
    doc.font('bold').fontSize(12);
    const nameHeight = doc.heightOfString(row.name, { width: 320 });
    const height = Math.max(116, nameHeight + 90);
    if (y + height > 760) {
      next('Вклад каждого', 'Продолжение');
      y = 175;
    }
    doc.roundedRect(42, y, width, height - 10, 12).fill('#FFFFFF');
    text(`${index + 1}. ${row.name}`, 58, y + 13, 12, INK, true, 315);
    text(
      `${fmt(row.points)}  /  ${row.ratio === null ? '—' : `${fmt(row.ratio)}×`}`,
      389,
      y + 13,
      12,
      INK,
      true,
      140,
    );
    const line = y + nameHeight + 27;
    text(
      `Начислено +${fmt(row.earnedPoints)}   Нарушения ${fmt(row.penaltyPoints)}   Выполнено ${row.completed}`,
      58,
      line,
      9,
      MUTED,
      false,
      width - 32,
    );
    doc.roundedRect(58, line + 24, width - 32, 6, 3).fill(PAPER);
    if (row.points > 0)
      doc
        .roundedRect(58, line + 24, Math.max(6, ((width - 32) * row.points) / max), 6, 3)
        .fill(YELLOW);
    text(
      `Прибытие ${row.categories.arrival}  ·  Выполнение ${row.categories.completion}  ·  Паспорта ${row.categories.passport}`,
      58,
      line + 41,
      9,
      MUTED,
      false,
      width - 32,
    );
    y += height;
  }
  if (report.engineers.length === 0)
    text('За этот период нет инженеров для сравнения.', 42, y, 12, MUTED);

  next('Качество управления', 'Диспетчер / итоги дней');
  text(
    '70% — обработка значимых алертов. 30% — выбор политики по сопоставимым измеренным результатам. Отсутствующие измерения отмечены явно.',
    42,
    155,
    11,
    MUTED,
  );
  y = 221;
  for (const day of report.days) {
    if (y > 710) {
      next('Качество управления', 'Продолжение');
      y = 178;
    }
    doc.roundedRect(42, y, width, 48, 10).fill('#FFFFFF');
    const scoreWidth = day.evaluated ? Math.max(4, ((width - 28) * day.score) / 100) : 0;
    if (scoreWidth > 0) doc.roundedRect(42, y + 40, scoreWidth, 4, 2).fill(YELLOW);
    text(day.workDate, 56, y + 12, 10, INK, true, 110);
    text(
      day.evaluated ? `${Math.round(day.score)} / 100` : 'Нет оценки',
      179,
      y + 12,
      10,
      INK,
      true,
      110,
    );
    text(
      `Задачи ${day.completed}   Алерты ${day.alertsResolved}/${day.alertsTotal}`,
      310,
      y + 16,
      10,
      MUTED,
      false,
      220,
    );
    y += 58;
  }
  if (report.days.length === 0) {
    text('Завершённых дней с сохранённой оценкой пока нет.', 42, y, 12, MUTED);
    y += 54;
  }
  const notes = [
    ...report.notes,
    'Баллы отражают помощь системе планирования. Они не заменяют оценку квалификации или качества выполненного монтажа.',
    'Обновлённое время: награда за попадание в интервал от 10 минут до срока до самого срока. Автоматических списаний нет; каждое нарушение фиксирует диспетчер с обоснованием.',
  ];
  for (const note of notes) {
    doc.font('regular').fontSize(10);
    const height = doc.heightOfString(note, { width, lineGap: 3 }) + 18;
    if (y + height > 750) {
      next('Как читать отчёт', 'Методика и полнота данных');
      y = 175;
    }
    text(note, 42, y, 10, MUTED);
    y += height;
  }
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    text(
      `NAVIX  /  ${report.month}${report.provisional ? '  /  предварительно' : ''}`,
      42,
      783,
      8,
      MUTED,
      false,
      400,
    );
    text(`${index + 1} / ${range.count}`, 490, 783, 8, MUTED, false, 65);
  }
  doc.end();
  return result;
}
