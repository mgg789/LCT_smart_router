import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMonthlyPoints, loadPassport, passportInputSchema, savePassport } from './passports';

afterEach(() => vi.unstubAllGlobals());

describe('passport API boundary', () => {
  it('requires actual field selections and bounds notes', () => {
    const empty = {
      connectionType: '',
      difficulty: 0,
      equipment: '',
      accessNotes: '',
      comment: '',
    };
    expect(passportInputSchema.safeParse(empty).success).toBe(false);
    expect(
      passportInputSchema.safeParse({ ...empty, connectionType: 'fiber', difficulty: 2 }).success,
    ).toBe(true);
    expect(
      passportInputSchema.safeParse({
        ...empty,
        connectionType: 'fiber',
        difficulty: 2,
        comment: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('retains the same operation id after a lost response', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network failed'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ passport: null, canFill: false, pointsAwarded: 35, monthlyPoints: 35 }),
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const input = {
      connectionType: 'fiber' as const,
      difficulty: 2,
      equipment: '',
      accessNotes: '',
      comment: '',
    };
    await expect(
      savePassport('test-token', 'request/1', 'stable-operation', input),
    ).rejects.toThrow();
    expect(await savePassport('test-token', 'request/1', 'stable-operation', input)).toMatchObject({
      monthlyPoints: 35,
    });
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).operationId)).toEqual([
      'stable-operation',
      'stable-operation',
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toContain('request%2F1/passport');
  });

  it('rejects an invalid server passport instead of silently showing incorrect facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ canFill: false, passport: { difficulty: 8 } })),
        ),
    );
    await expect(loadPassport('test-token', 'engineer', 'r1')).rejects.toThrow();
  });

  it('reads own or explicitly selected engineer monthly totals without sending a write', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ monthlyPoints: 0, month: '2026-10' }))),
      );
    vi.stubGlobal('fetch', fetcher);
    await loadMonthlyPoints('test-token');
    await loadMonthlyPoints('test-token', 'e/2');
    expect(fetcher.mock.calls[0]?.[0]).toContain('/engineer/points');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/dispatch/engineers/e%2F2/points');
  });
});
