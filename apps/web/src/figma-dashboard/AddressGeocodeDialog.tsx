import { useEffect, useMemo, useState } from 'react';
import { geocodeDataset } from '../api/client';
import { isNavixOffline } from '../domain/mapAvailability';
import { t } from '../i18n';

export interface PlacedPoint {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Asks whether address-only rows should be geocoded.
 * A miss stays without coordinates. Built-in geocodes are never replaced by a guess.
 */
export function AddressGeocodeDialog({
  token,
  addresses,
  onDone,
  onCancel,
}: {
  token: string;
  addresses: readonly string[];
  onDone: (points: Record<string, PlacedPoint>) => void;
  onCancel: () => void;
}) {
  const offline = isNavixOffline();
  const unique = useMemo(
    () => [
      ...new Set(
        addresses.map((address) => address.trim()).filter((address) => address.length >= 3),
      ),
    ],
    [addresses],
  );
  const minutes = Math.max(1, Math.ceil((unique.length * 6) / 60 / 60));
  const [running, setRunning] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [points, setPoints] = useState<Record<string, PlacedPoint> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setRemainingSec((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const leaveUnplaced = () => {
    setPoints({});
    setSummary(
      t('figma-dashboard.AddressGeocodeDialog.summary', {
        value0: 0,
        value1: 0,
        value2: unique.length,
      }),
    );
  };

  const launch = () => {
    const estimate = Math.max(5, Math.ceil((unique.length * 6) / 60));
    setRunning(true);
    setError(null);
    setRemainingSec(estimate);
    void geocodeDataset(token, unique, estimate * 1000 + 30_000)
      .then((result) => {
        if (!result.available) {
          setError(t('figma-dashboard.AddressGeocodeDialog.offline'));
          return;
        }
        const next: Record<string, PlacedPoint> = {};
        for (const point of result.points) {
          next[point.address] = { lat: point.lat, lon: point.lon };
        }
        setPoints(next);
        setSummary(
          t('figma-dashboard.AddressGeocodeDialog.summary', {
            value0: result.house,
            value1: result.street,
            value2: result.approximate,
          }),
        );
      })
      .catch(() => setError(t('figma-dashboard.AddressGeocodeDialog.failed')))
      .finally(() => setRunning(false));
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 p-[24px]">
      <div className="w-full max-w-[520px] rounded-[24px] bg-white p-[24px] text-figma-ink">
        <p className="font-semibold text-[18px]">
          {offline
            ? t('figma-dashboard.AddressGeocodeDialog.offline')
            : t('figma-dashboard.AddressGeocodeDialog.prompt', { value0: minutes })}
        </p>
        {running ? (
          <p className="mt-[12px] text-[15px] text-figma-muted">
            {t('figma-dashboard.AddressGeocodeDialog.remaining', { value0: remainingSec })}
          </p>
        ) : null}
        {summary ? <p className="mt-[12px] text-[15px]">{summary}</p> : null}
        {error ? <p className="mt-[12px] text-[15px] text-figma-cancel">{error}</p> : null}
        <div className="mt-[20px] flex gap-[12px]">
          {points ? (
            <button
              type="button"
              className="h-[48px] flex-1 rounded-[16px] bg-figma-bee font-semibold"
              onClick={() => onDone(points)}
            >
              {t('figma-dashboard.AddressGeocodeDialog.continue')}
            </button>
          ) : (
            <>
              {offline ? null : (
                <button
                  type="button"
                  disabled={running}
                  className="h-[48px] flex-1 rounded-[16px] bg-figma-bee font-semibold disabled:opacity-50"
                  onClick={launch}
                >
                  {t('figma-dashboard.AddressGeocodeDialog.launch')}
                </button>
              )}
              <button
                type="button"
                disabled={running}
                className="h-[48px] flex-1 rounded-[16px] bg-figma-soft font-semibold disabled:opacity-50"
                onClick={leaveUnplaced}
              >
                {t('figma-dashboard.AddressGeocodeDialog.approximate')}
              </button>
              <button
                type="button"
                disabled={running}
                className="h-[48px] flex-1 rounded-[16px] font-semibold text-figma-muted disabled:opacity-50"
                onClick={onCancel}
              >
                {t('figma-dashboard.AddressGeocodeDialog.cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
