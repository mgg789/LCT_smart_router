import { useEffect, useState } from 'react';
import { loadMonthlyPoints } from '../../api/passports';
import { t } from '../../i18n';
import { RewardDetails } from '../rewards/RewardDetails';

/** Shows the compact monthly score and refreshes on saves, focus and month rollover. */
export function MonthlyPoints({ token, engineerId }: { token: string; engineerId?: string }) {
  const [open, setOpen] = useState(false);
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
    window.addEventListener('engineer-rewards-changed', read);
    window.addEventListener('focus', read);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('object-passport-saved', read);
      window.removeEventListener('engineer-rewards-changed', read);
      window.removeEventListener('focus', read);
    };
  }, [token, engineerId, key]);
  const current = result?.key === key ? result : null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-9 items-center gap-2 rounded-full bg-figma-bee px-3 py-2 font-semibold text-figma-ink"
        aria-label={
          current?.failed
            ? t('components.passports.MonthlyPoints.8ba3a6918c')
            : t('components.passports.MonthlyPoints.6c6f04aa01', { value0: current?.points ?? '—' })
        }
        aria-live="polite"
        title={
          current?.failed
            ? t('components.passports.MonthlyPoints.8ba3a6918c')
            : t('components.passports.MonthlyPoints.d2c8ae78bd')
        }
      >
        <span>{current?.points ?? '—'}</span>
        <img src="/figma/carambola.svg" alt="" className="size-5" />
      </button>
      <RewardDetails
        token={token}
        engineerId={engineerId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
