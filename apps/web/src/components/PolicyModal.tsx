import { useEffect, useRef, useState } from 'react';
import type { PolicyId, PolicySpec, RouterTechnicalSettings } from '../api/types';
import { POLICY_DESCRIPTIONS, POLICY_LABELS } from '../lib/reasons';

interface PolicyModalProps {
  readonly open: boolean;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  readonly routerSettings?: RouterTechnicalSettings;
  readonly policies: readonly PolicySpec[];
  readonly onClose: () => void;
  readonly onApply: (policyId: PolicyId, settings: RouterTechnicalSettings) => void;
}

export function PolicyModal({
  open,
  policyId,
  lunchesEnabled,
  routerSettings,
  policies,
  onClose,
  onApply,
}: PolicyModalProps) {
  const [draftPolicyId, setDraftPolicyId] = useState(policyId);
  const [draftLunches, setDraftLunches] = useState(lunchesEnabled);
  const [draftWindowLateness, setDraftWindowLateness] = useState(0);
  const [draftAccessBufferMin, setDraftAccessBufferMin] = useState(10);
  const [draftTraffic, setDraftTraffic] = useState(true);
  const [draftEquipment, setDraftEquipment] = useState(true);

  const wasOpen = useRef(false);
  useEffect(() => {
    // Polling returns a new settings object; never overwrite an open draft.
    if (open && !wasOpen.current) {
      setDraftPolicyId(policyId);
      setDraftLunches(lunchesEnabled);
      setDraftWindowLateness(routerSettings?.windowLatenessToleranceSec ?? 0);
      setDraftAccessBufferMin(Math.round((routerSettings?.accessBufferSec ?? 600) / 60));
      setDraftTraffic(routerSettings?.trafficEnabled ?? true);
      setDraftEquipment(routerSettings?.equipmentEnabled ?? true);
    }
    wasOpen.current = open;
  }, [lunchesEnabled, open, policyId, routerSettings]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-ink/40"
        aria-label="Закрыть политику"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-modal-title"
        className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-lg"
      >
        <h2 id="policy-modal-title" className="text-lg font-semibold">
          Политика маршрутизации
        </h2>
        <p className="mt-1 text-sm text-muted">
          Смена политики или настроек сама запускает пересборку. Отдельная кнопка «пересчитать» не
          нужна. Базовый FIFO из ТЗ здесь не выбирается — он всегда считается и выделен на вкладке
          «Политики» для сравнения.
        </p>

        <ul className="mt-4 space-y-2">
          {policies.map((policy) => {
            const selected = policy.policyId === draftPolicyId;
            return (
              <li key={policy.policyId}>
                <button
                  type="button"
                  onClick={() => setDraftPolicyId(policy.policyId)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left ${
                    selected ? 'border-ink bg-canvas' : 'border-line hover:bg-canvas/70'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {POLICY_LABELS[policy.policyId] ?? policy.title}
                    </span>
                    {policy.isDefault ? (
                      <span className="text-[11px] text-muted">по умолчанию</span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-[13px] text-muted">
                    {POLICY_DESCRIPTIONS[policy.policyId] ?? 'Готовый пресет маршрутизации.'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-line px-3 py-3">
          <div>
            <p className="font-medium">{draftLunches ? 'Обед включён' : 'Обед выключен'}</p>
            <p className="mt-1 text-[13px] text-muted">
              По умолчанию солвер обеды не ставит. Включение добавляет интервал в окне 11:20–15:00
              без точки GPS.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Обеды в плане"
            aria-checked={draftLunches}
            onClick={() => setDraftLunches((value) => !value)}
            className={`mt-1 flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors ${
              draftLunches ? 'justify-end bg-bee' : 'justify-start bg-line'
            }`}
          >
            <span className="h-6 w-6 rounded-full bg-white shadow" />
          </button>
        </div>

        <div className="mt-4 space-y-3 rounded-2xl border border-line px-3 py-3">
          <div>
            <p className="font-medium">Технические ограничения</p>
            <p className="mt-1 text-[13px] text-muted">
              Допуск опоздания измеряется относительно исходного окна клиента, которое было у заявки
              до расчёта маршрута.
            </p>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Опоздание окна клиента</span>
            <select
              value={draftWindowLateness}
              onChange={(event) => setDraftWindowLateness(Number(event.target.value))}
              className="rounded-xl border border-line bg-white px-2 py-1.5 text-sm"
            >
              {[0, 5, 10, 15, 20].map((minutes) => (
                <option key={minutes} value={minutes * 60}>
                  {minutes === 0 ? 'Нет допуска' : `${minutes} мин`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Буфер доступа, мин</span>
            <input
              type="number"
              min={0}
              max={1440}
              step={1}
              value={draftAccessBufferMin}
              onChange={(event) => setDraftAccessBufferMin(Number(event.target.value) || 0)}
              className="w-24 rounded-xl border border-line bg-white px-2 py-1.5 text-right text-sm"
            />
          </label>
          <SettingSwitch
            label="Прогнозные пробки"
            checked={draftTraffic}
            onChange={() => setDraftTraffic((value) => !value)}
          />
          <SettingSwitch
            label="Учитывать оборудование"
            checked={draftEquipment}
            onChange={() => setDraftEquipment((value) => !value)}
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-4 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(draftPolicyId, {
                ...(routerSettings ?? {
                  departureLatenessToleranceSec: 0,
                  taskStartLatenessToleranceSec: 0,
                  travelTimeMode: 'graph_with_access_buffer' as const,
                  fixedTravelTimeSec: 1_200,
                  earlyFinishReplanThresholdSec: 900,
                  taskOverrunToleranceSec: 600,
                  routerContextVersion: '',
                }),
                lunchesEnabled: draftLunches,
                windowLatenessToleranceSec: draftWindowLateness,
                accessBufferSec: Math.max(0, Math.min(86_400, draftAccessBufferMin * 60)),
                trafficEnabled: draftTraffic,
                equipmentEnabled: draftEquipment,
              });
              onClose();
            }}
            className="rounded-full bg-bee px-4 py-2 text-sm font-semibold"
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}

interface SettingSwitchProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: () => void;
}

/** Compact accessible switch for one boolean Router technical setting. */
function SettingSwitch({ label, checked, onChange }: SettingSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={onChange}
        className={`flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? 'justify-end bg-bee' : 'justify-start bg-line'
        }`}
      >
        <span className="h-6 w-6 rounded-full bg-white shadow" />
      </button>
    </div>
  );
}
