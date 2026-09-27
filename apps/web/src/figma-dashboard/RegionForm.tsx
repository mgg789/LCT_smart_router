import { useEffect, useState } from 'react';
import { createDispatchRegion, type DispatchRegion, loadDispatchRegions } from '../api/regions';
import { t } from '../i18n';
import { AddressPointField } from './AddressPointField';

/** Adds a durable region; existing offices remain visible while choosing its location. */
export function RegionForm({
  token,
  onError,
  onStatus,
  onCreated,
  onBusy,
}: {
  token: string | null;
  onError: (message: string | null) => void;
  onStatus: (message: string | null) => void;
  onCreated?: () => Promise<unknown>;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [offices, setOffices] = useState<DispatchRegion[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (token)
      void loadDispatchRegions(token)
        .then((rows) => {
          if (!cancelled) {
            setOffices(rows);
            setLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled) onError(t('figma-dashboard.RegionForm.6a9e6fd1c3'));
        });
    return () => {
      cancelled = true;
    };
  }, [token, onError]);
  return (
    <form
      id="add-form-region"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        onStatus(null);
        if (!token || !loaded) {
          onError(t('figma-dashboard.RegionForm.122b83b734'));
          return;
        }
        if (!name.trim() || !address.trim() || !point) {
          onError(t('figma-dashboard.RegionForm.5bab74a793'));
          return;
        }
        onBusy(true);
        void createDispatchRegion(token, {
          name: name.trim(),
          addressText: address.trim(),
          ...point,
        })
          .then(async () => {
            setOffices(await loadDispatchRegions(token));
            setName('');
            setAddress('');
            setPoint(null);
            onStatus(t('figma-dashboard.RegionForm.88974d440b'));
            await onCreated?.();
          })
          .catch((cause: unknown) =>
            onError(
              cause instanceof Error ? cause.message : t('figma-dashboard.RegionForm.b6db0833e8'),
            ),
          )
          .finally(() => onBusy(false));
      }}
    >
      <label htmlFor="add-region-name" className="block font-semibold text-[16px] text-figma-ink">
        {t('figma-dashboard.RegionForm.67d0202dc7')}
      </label>
      <input
        id="add-region-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        className="mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] text-figma-ink"
      />
      <AddressPointField
        id="add-region-office"
        label={t('figma-dashboard.RegionForm.32e658c99f')}
        token={token}
        addressText={address}
        lat={point?.lat ?? null}
        lon={point?.lon ?? null}
        offices={offices}
        onAddressChange={(value) => {
          setAddress(value);
          setPoint(null);
        }}
        onResolved={(hit) => {
          setAddress(hit.displayName);
          setPoint(hit);
        }}
        onMapPick={(lat, lon) => {
          setPoint({ lat, lon });
          if (!address.trim()) setAddress(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
        }}
      />
      <p className="mt-[12px] text-[14px] text-figma-muted">
        {t('figma-dashboard.RegionForm.379a75ce8d')}
      </p>
    </form>
  );
}
