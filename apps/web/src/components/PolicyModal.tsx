import { useEffect, useState } from 'react';
import type { PolicyId, PolicySpec } from '../api/types';
import { POLICY_LABELS } from '../lib/reasons';

interface PolicyModalProps {
  readonly open: boolean;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  readonly policies: readonly PolicySpec[];
  readonly onClose: () => void;
  readonly onApply: (policyId: PolicyId, lunchesEnabled: boolean) => void;
}

export function PolicyModal({
  open,
  policyId,
  lunchesEnabled,
  policies,
  onClose,
  onApply,
}: PolicyModalProps) {
  const [draftPolicyId, setDraftPolicyId] = useState(policyId);
  const [draftLunches, setDraftLunches] = useState(lunchesEnabled);

  useEffect(() => {
    if (open) {
      setDraftPolicyId(policyId);
      setDraftLunches(lunchesEnabled);
    }
  }, [lunchesEnabled, open, policyId]);

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
        className="relative w-full max-w-md rounded-2xl bg-white p-5 shadow-lg"
      >
        <h2 id="policy-modal-title" className="text-lg font-semibold">
          Политика маршрутизации
        </h2>
        <p className="mt-1 text-sm text-muted">
          Смена политики или обеда сама запускает пересборку. Отдельная кнопка «пересчитать» не
          нужна.
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
                  <span className="mt-1 block text-[13px] text-muted">{policy.description}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-line px-3 py-3">
          <div>
            <p className="font-medium">{draftLunches ? 'Обед включён' : 'Обед выключен'}</p>
            <p className="mt-1 text-[13px] text-muted">
              По умолчанию солвер обеды не ставит. Включение добавляет интервал в окне 11:20–13:00
              без точки GPS.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Обеды в плане"
            aria-checked={draftLunches}
            onClick={() => setDraftLunches((value) => !value)}
            className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors ${
              draftLunches ? 'bg-bee' : 'bg-line'
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                draftLunches ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
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
              onApply(draftPolicyId, draftLunches);
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
