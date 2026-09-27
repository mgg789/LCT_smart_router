import type { WorkTypeView } from '@lct/shared';

/** One catalogue selector for both forms, with a distinct accessible emergency action. */
export function WorkTypePicker({
  rows,
  value,
  onChange,
  error,
  onRetry,
  showEmergencyAction = true,
}: {
  showEmergencyAction?: boolean;
  rows: readonly WorkTypeView[];
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  onRetry: () => void;
}) {
  const emergency = rows.find((row) => row.category === 'emergency');
  const selected = rows.find((row) => row.code === value);
  return (
    <div className="flex flex-col gap-[12px]">
      {emergency && showEmergencyAction ? (
        <button
          type="button"
          aria-pressed={selected?.category === 'emergency'}
          onClick={() => onChange(emergency.code)}
          className={`rounded-[20px] border border-figma-danger px-[20px] py-[12px] font-semibold transition-colors ${selected?.category === 'emergency' ? 'bg-figma-danger text-white' : 'bg-white text-figma-danger hover:bg-figma-danger/10'}`}
        >
          Авария
        </button>
      ) : null}
      <select
        aria-label="Тип заявки"
        value={value}
        disabled={rows.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-[20px] border bg-white px-[18px] py-[14px] font-medium ${selected?.category === 'emergency' ? 'border-figma-danger text-figma-danger' : 'border-figma-ink/15 text-figma-ink'}`}
      >
        {!selected ? (
          <option value="">{rows.length === 0 ? 'Загружаем типы…' : 'Выберите тип заявки'}</option>
        ) : null}
        {(['emergency', 'connection', 'service'] as const).map((category) => {
          const group = rows.filter((row) => row.category === category);
          return group.length ? (
            <optgroup key={category} label={group[0]?.categoryTitle ?? ''}>
              {group.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.title}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      {selected?.category === 'emergency' ? (
        <p className="text-center text-[14px] text-figma-danger">
          Направим первую свободную бригаду
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="text-[14px] text-figma-danger">
          {error}{' '}
          <button type="button" onClick={onRetry} className="underline">
            Повторить
          </button>
        </div>
      ) : null}
    </div>
  );
}
