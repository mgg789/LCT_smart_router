import { ArrowUpRight, Bell, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { countUnseen, useAlerts } from '@/entities/alert';
import { activePolicyTitle, usePolicies } from '@/entities/policy';
import { useSessionStore } from '@/entities/session';
import { useSignOut } from '@/features/auth/sign-out';
import { Monogram } from '@/shared/ui';
import { AlertsPopover } from './AlertsPopover';
import { PolicyPopover } from './PolicyPopover';

/** Only one panel may be open at a time. */
type OpenPanel = 'policy' | 'alerts' | 'account' | null;

/** Label of the policy pill, honest about the three states it can be in. */
function usePolicyLabel(): string {
  const { data, isPending, isError } = usePolicies();

  if (isPending) return 'Политика: загружаем…';
  if (isError || !data) return 'Политика: нет связи';

  return `Политика: ${activePolicyTitle(data)}`;
}

/**
 * Top bar of the dashboard: the policy in force, search, alerts and the account.
 *
 * The policy pill and the bell open popovers rather than navigating — the
 * dispatcher switches policy and scans alerts without leaving the day.
 *
 * Search has no endpoint behind it — filtering belongs to each section — so the
 * control is disabled instead of pretending to work.
 */
export function AppHeader() {
  const policyLabel = usePolicyLabel();
  const alerts = useAlerts();
  const unseen = countUnseen(alerts.data);
  const email = useSessionStore((state) => state.session?.email ?? '');
  const signOut = useSignOut();

  const [panel, setPanel] = useState<OpenPanel>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  const toggle = (next: Exclude<OpenPanel, null>) =>
    setPanel((current) => (current === next ? null : next));
  const close = () => setPanel(null);

  useEffect(() => {
    if (panel !== 'account') return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setPanel(null);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [panel]);

  return (
    <header className="flex shrink-0 items-center justify-end gap-7 pr-[34px] pt-8 pb-[31px]">
      <div className="relative">
        <button
          aria-expanded={panel === 'policy'}
          aria-haspopup="dialog"
          className="flex h-10 items-center gap-[22px] rounded-full bg-surface pr-[3px] pl-[18px] text-[18px] text-ink"
          onClick={() => toggle('policy')}
          type="button"
        >
          {policyLabel}
          <span className="flex size-11 items-center justify-center rounded-full bg-ink text-white">
            <ArrowUpRight aria-hidden size={20} />
          </span>
        </button>
        {panel === 'policy' ? <PolicyPopover onClose={close} /> : null}
      </div>

      <button
        aria-label="Поиск появится вместе с разделами"
        className="text-ink disabled:opacity-40"
        disabled
        title="Поиск появится вместе с разделами"
        type="button"
      >
        <Search aria-hidden size={24} />
      </button>

      <div className="relative">
        <button
          aria-expanded={panel === 'alerts'}
          aria-haspopup="dialog"
          aria-label={unseen > 0 ? `Алерты, непросмотренных: ${unseen}` : 'Алерты'}
          className="relative block text-ink"
          onClick={() => toggle('alerts')}
          type="button"
        >
          <Bell aria-hidden size={24} />
          {unseen > 0 ? (
            <span className="-top-1.5 -right-2 absolute min-w-[18px] rounded-full bg-ink px-1 text-center text-[11px] text-white leading-[18px]">
              {unseen > 99 ? '99+' : unseen}
            </span>
          ) : null}
        </button>
        {panel === 'alerts' ? <AlertsPopover onClose={close} /> : null}
      </div>

      <div className="relative flex items-center gap-2" ref={accountRef}>
        <Monogram name={email} size={48} />
        <button
          aria-expanded={panel === 'account'}
          aria-label="Меню аккаунта"
          className="text-ink"
          onClick={() => toggle('account')}
          type="button"
        >
          <ChevronDown aria-hidden size={20} />
        </button>

        {panel === 'account' ? (
          <div className="absolute top-[56px] right-0 z-10 w-[240px] rounded-2xl bg-surface p-4 shadow-lg">
            <p className="truncate text-[13px] text-ink/60">{email}</p>
            <button
              className="mt-3 w-full rounded-xl bg-ink px-4 py-2 text-[14px] text-white disabled:opacity-50"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
              type="button"
            >
              {signOut.isPending ? 'Выходим…' : 'Выйти'}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
