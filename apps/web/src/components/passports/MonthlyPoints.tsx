import { useEffect, useState } from 'react';
import { loadMonthlyPoints } from '../../api/passports';

/** Shows the compact monthly score and refreshes on saves, focus and month rollover. */
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
    <div
      className="inline-flex min-h-9 items-center gap-2 rounded-full bg-figma-bee px-3 py-2 font-semibold text-figma-ink"
      role="status"
      aria-label={
        current?.failed ? 'Не удалось загрузить баллы' : `${current?.points ?? '—'} баллов`
      }
      aria-live="polite"
      title={current?.failed ? 'Не удалось загрузить баллы' : 'Баллы за текущий месяц'}
    >
      <span>{current?.points ?? '—'}</span>
      <img src="/figma/carambola.svg" alt="" className="size-5" />
    </div>
  );
}
