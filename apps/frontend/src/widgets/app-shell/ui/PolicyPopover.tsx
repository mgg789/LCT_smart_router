import { useDispatchState } from '@/entities/plan';
import type { PolicyId } from '@/entities/policy';
import { policyTitle, usePolicies } from '@/entities/policy';
import { useRouterSettings } from '@/entities/router-settings';
import { useSetDispatchMode } from '@/features/dispatch/set-mode';
import { useSelectPolicy } from '@/features/policy/select-policy';
import { useToggleLunches } from '@/features/router/toggle-lunches';
import { cn } from '@/shared/lib';
import { Popover, Switch } from '@/shared/ui';

export interface PolicyPopoverProps {
  onClose: () => void;
}

interface PolicyRowProps {
  title: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}

/**
 * One preset: a 24px radio at 16px from the edge, label at 50px, 44px pitch.
 *
 * A real `<input type="radio">` carries the state, so the browser gives arrow-key
 * navigation across the group for free.
 */
function PolicyRow({ title, selected, disabled, onSelect }: PolicyRowProps) {
  return (
    <label className={cn('flex h-[44px] items-center gap-[10px]', disabled && 'opacity-50')}>
      <span className="relative inline-flex size-[24px] shrink-0">
        <input
          checked={selected}
          className="peer size-[24px] cursor-pointer appearance-none rounded-full border-2 border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          disabled={disabled}
          name="dispatch-policy"
          onChange={onSelect}
          type="radio"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto hidden size-[12px] rounded-full bg-ink peer-checked:block"
        />
      </span>
      <span
        className={cn(
          'cursor-pointer text-[20px] font-medium text-ink',
          selected && 'font-semibold',
        )}
      >
        {title}
      </span>
    </label>
  );
}

/**
 * Policy popover of the header (Figma `37:840`).
 *
 * The list comes from `GET /dispatch/policies`, not from the drawing: the API is
 * what decides which presets can be applied. That is why the sixth row is
 * «Полное покрытие» and not the drawn «Базовая из ТЗ» — the baseline is a
 * comparison row, not a policy the dispatcher can switch to.
 */
export function PolicyPopover({ onClose }: PolicyPopoverProps) {
  const policies = usePolicies();
  const settings = useRouterSettings();
  const dispatchState = useDispatchState();

  const selectPolicy = useSelectPolicy();
  const toggleLunches = useToggleLunches();
  const setMode = useSetDispatchMode();

  const activeId = policies.data?.active.policyId;
  const isManual = dispatchState.data?.mode === 'manual';
  const busy = selectPolicy.isPending || toggleLunches.isPending || setMode.isPending;

  const handleSelect = (policyId: PolicyId) => {
    if (policyId === activeId) return;
    selectPolicy.mutate(policyId);
  };

  return (
    <Popover className="right-auto left-0" onClose={onClose} title="Выбери свою политику">
      {policies.isPending ? <p className="text-[14px] text-ink/60">Загружаем политики…</p> : null}
      {policies.isError ? (
        <p className="text-[14px] text-danger">Не удалось прочитать список политик.</p>
      ) : null}

      {policies.data ? (
        <fieldset className="border-0 p-0">
          <legend className="sr-only">Политика планирования</legend>
          {policies.data.policies.map((policy) => (
            <PolicyRow
              disabled={busy}
              key={policy.policyId}
              onSelect={() => handleSelect(policy.policyId)}
              selected={policy.policyId === activeId}
              title={policyTitle(policy.policyId, policy.title)}
            />
          ))}
        </fieldset>
      ) : null}

      <div className="mt-[6px] flex h-[29px] items-center gap-[10px]">
        <Switch
          checked={settings.data?.lunchesEnabled ?? false}
          disabled={busy || !settings.data}
          label="Обед включён"
          onChange={(next) => toggleLunches.mutate(next)}
        />
        <span className="text-[20px] font-medium text-ink">Обед включён</span>
      </div>

      <button
        className="mt-4 flex h-[67px] w-full items-center justify-center rounded-[20px] bg-accent text-[20px] font-semibold tracking-[-0.6px] text-ink disabled:opacity-50"
        disabled={busy || !dispatchState.data}
        onClick={() => setMode.mutate(isManual ? 'auto' : 'manual')}
        type="button"
      >
        {isManual ? 'Вернуть автоматический режим' : 'Ручное управление'}
      </button>

      {selectPolicy.isError || toggleLunches.isError || setMode.isError ? (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          Действие не применилось. Повторите — состояние на экране не изменилось.
        </p>
      ) : null}
    </Popover>
  );
}
