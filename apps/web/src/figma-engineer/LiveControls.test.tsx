import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EngineerLiveView } from '../api/live';
import { DESIGN_PREVIEW_PLAN } from './designPreview';
import { LiveControls, LiveDayOverlay } from './LiveControls';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

const stats = {
  completedCount: 1,
  cancelledCount: 0,
  assumedCompletedCount: 0,
  problemCount: 0,
  technicalBreakCount: 0,
};
const request = DESIGN_PREVIEW_PLAN.requests[0];
if (!request) throw new Error('Missing test visit');
const live: EngineerLiveView = {
  workday: {
    id: 'day',
    workDate: '2026-09-20',
    status: 'running',
    logicalStartAt: 1,
    logicalEndAt: 200,
    startedAtWallSec: 1,
    finishedAt: null,
    completionReason: null,
    liveNow: 100,
    speedDurationSec: 3600,
    speedFactor: 11,
    engineerStartDeadlineAt: 1801,
    requestCount: 14,
    stats,
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    lineStatus: 'online',
    availability: 'online',
    activeRequestId: null,
    technicalBreak: null,
    progress: null,
    routeState: 'active',
    stats,
    pendingDelayProblem: null,
  },
  current: {
    request,
    stop: null,
    phase: 'awaiting_window',
    expectedCompletionAt: null,
    overrunAt: null,
  },
  route: DESIGN_PREVIEW_PLAN.route,
  lunch: null,
};
const send = async () => true;
const controls = (value: EngineerLiveView) =>
  renderToStaticMarkup(<LiveControls live={value} now={100} busy={false} send={send} />);
const overlay = (value: EngineerLiveView) =>
  renderToStaticMarkup(<LiveDayOverlay live={value} now={100} busy={false} send={send} />);

describe('Figma engineer LIVE controls', () => {
  it('replaces the window with one arrival label and aligned rectangular controls', () => {
    vi.mocked(useState).mockReturnValueOnce(['eta', vi.fn()]);
    const html = controls(live);
    expect(html.match(/>Время прибытия</g)).toHaveLength(1);
    expect(html).toContain('type="time"');
    expect(html).toContain('Установить');
    expect(html).not.toContain('Закрыть форму');
    expect(html).toContain('height:calc(82 * var(--eu))');
  });
  it('switches from arrival promises to start and then finish/problem', () => {
    const current = live.current;
    if (!current) throw new Error('Missing current visit');
    expect(controls(live)).not.toContain('Буду вовремя');
    expect(controls(live)).toContain('Опаздываю');
    expect(controls({ ...live, current: { ...current, phase: 'ready_to_start' } })).toContain(
      'Приступить',
    );
    const working = controls({
      ...live,
      current: { ...current, phase: 'in_progress', overrunAt: 99 },
    });
    expect(working).toContain('Завершить');
    expect(working).toContain('Проблема');
    expect(working).toContain('bg-figma-cancel');
    expect(working).not.toContain('Приступить');
  });
  it('blocks job actions during lunch, technical breaks and before day start', () => {
    const lunch = { ...live, lunch: { startedAt: 50, endAt: 150 } };
    expect(controls(lunch)).toBe('');
    expect(overlay(lunch)).toContain('00:50');
    const paused = {
      ...live,
      engineer: {
        ...live.engineer,
        lineStatus: 'technical_break' as const,
        technicalBreak: { startedAt: 1, plannedEndAt: 90, overdueAt: 99 },
      },
    };
    expect(controls(paused)).toBe('');
    expect(overlay(paused)).toContain('Вернуться');
    expect(overlay(paused)).toContain('Диспетчер уведомлён');
    const pending = { ...live, workday: { ...live.workday, status: 'pending' as const } };
    expect(controls(pending)).toBe('');
    expect(overlay(pending)).toContain('Ожидаем начала дня');
  });
  it('offers explicit line entry and never duplicates it after a previous entry', () => {
    const waiting = {
      ...live,
      engineer: { ...live.engineer, lineStatus: 'pending' as const, lineStartedAt: null },
    };
    expect(overlay(waiting)).toContain('Выйти на линию');
    expect(overlay({ ...waiting, engineer: { ...waiting.engineer, lineStartedAt: 90 } })).toBe('');
  });
});
