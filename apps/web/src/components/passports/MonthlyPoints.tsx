import { useEffect, useState } from 'react';
import { loadMonthlyPoints } from '../../api/passports';

/** Shows a server total and refreshes on saves, focus and month rollover. */
export function MonthlyPoints({ token, engineerId }: { token: string; engineerId?: string }) {
  const key = `${token}:${engineerId ?? 'self'}`;
  const [result, setResult] = useState<{
    key: string;
    points: number | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await loadMonthlyPoints(token, engineerId);
        if (!disposed) setResult({ key, points: data.monthlyPoints, failed: false });
      } catch {
        if (!disposed) setResult({ key, points: null, failed: true });
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    window.addEventListener('object-passport-saved', read);
    window.addEventListener('focus', read);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('object-passport-saved', read);
      window.removeEventListener('focus', read);
    };
  }, [token, engineerId, key]);
  const current = result?.key === key ? result : null;
  return (
    <div className="rounded-[20px] bg-figma-bee px-4 py-3 text-figma-ink" aria-live="polite">
      <p className="font-semibold">{current?.points ?? '—'} баллов за месяц</p>
      <p className="mt-1 text-xs">
        {current?.failed ? 'Не удалось загрузить баллы' : 'Новый отсчёт — 1 числа'}
      </p>
    </div>
  );
}
