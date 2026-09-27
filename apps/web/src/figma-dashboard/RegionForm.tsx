import { useEffect, useState } from 'react';
import { createDispatchRegion, type DispatchRegion, loadDispatchRegions } from '../api/regions';
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
          if (!cancelled) onError('Не удалось загрузить офисы. Откройте вкладку повторно.');
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
          onError('Нужно подключение к серверу и список офисов.');
          return;
        }
        if (!name.trim() || !address.trim() || !point) {
          onError('Укажите название, адрес и точку офиса на карте.');
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
            onStatus('Регион добавлен. Новые заявки будут относиться к ближайшему офису.');
            await onCreated?.();
          })
          .catch((cause: unknown) =>
            onError(cause instanceof Error ? cause.message : 'Не удалось добавить регион'),
          )
          .finally(() => onBusy(false));
      }}
    >
      <label htmlFor="add-region-name" className="block font-semibold text-[16px] text-figma-ink">
        Название региона
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
        label="Адрес офиса"
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
        На карте отмечены существующие офисы. Регион создаётся без заявок и инженеров.
      </p>
    </form>
  );
}
