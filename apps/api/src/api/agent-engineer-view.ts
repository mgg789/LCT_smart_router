import { formatUnixSeconds } from '../common/time';
import type { EngineerDay } from '../generated/prisma/client';
import { toDayView } from './engineer-view';
import type { DispatchLiveView } from './live-view.types';

/** Separates factual check-in from planning eligibility in AI and MCP evidence. */
export function agentEngineerAttendance(
  engineer?: Pick<
    DispatchLiveView['engineers'][number],
    'lineStatus' | 'lineStartedAt' | 'availability'
  >,
) {
  const status = engineer?.lineStatus ?? null;
  const labels: Record<string, string> = {
    pending: 'Ожидает выхода на линию',
    online: 'Вышел на линию',
    no_show_offline: 'Не вышел на линию',
    technical_break: 'Технический перерыв',
    finished: 'Завершил смену',
  };
  return {
    lineStatus: status,
    label: status ? (labels[status] ?? status) : 'Нет подтверждённого состояния текущего дня',
    checkedIn: engineer?.lineStartedAt != null,
    lineStartedAt: engineer?.lineStartedAt ?? null,
    isOnLine: status === 'online' && engineer?.lineStartedAt != null,
    planningAvailability: engineer?.availability ?? null,
    availabilityMeaning: 'Доступность для планирования не подтверждает фактический выход на линию.',
  };
}

/** Current-day evidence with formatted local times; raw seconds remain unchanged. */
export function toAgentDayView(day: EngineerDay, timeZone: string) {
  return {
    ...toDayView(day),
    timeZone,
    shiftStartLocal: formatUnixSeconds(Number(day.shiftStartAt), timeZone),
    shiftEndLocal: formatUnixSeconds(Number(day.shiftEndAt), timeZone),
    availabilityMeaning: 'Planning eligibility only. Use attendance.isOnLine for actual check-in.',
  };
}
