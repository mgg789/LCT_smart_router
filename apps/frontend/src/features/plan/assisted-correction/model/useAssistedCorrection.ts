import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  type AssistedChange,
  type AssistedProposal,
  assistedProposalSchema,
  assistedStateQueryKey,
  getAssistedState,
  useAssistedState,
} from '@/entities/dispatcher-constraints';
import { liveQueryKey } from '@/entities/live';
import { planQueryKey } from '@/entities/plan';
import { requestsQueryKey } from '@/entities/request';
import { isApiError } from '@/shared/api';
import { applyCorrection, cancelCorrection, prepareCorrection } from '../api/corrections';

function proposalFromError(error: unknown): AssistedProposal | null {
  if (
    !isApiError(error) ||
    typeof error.details !== 'object' ||
    error.details === null ||
    !('proposal' in error.details)
  )
    return null;
  const parsed = assistedProposalSchema.safeParse(error.details.proposal);
  return parsed.success ? parsed.data : null;
}

function message(error: unknown): string {
  if (!isApiError(error)) return 'Не удалось проверить изменение. Рабочий план сохранён.';
  if (error.code === 'VERSION_CONFLICT')
    return 'Данные изменились. Пересчитайте предложение перед применением.';
  if (error.code === 'ROUTER_UNAVAILABLE' || error.code === 'SERVICE_NOT_CONFIGURED')
    return 'Расчёт сейчас недоступен. Рабочий план сохранён.';
  if (error.code === 'MODE_AUTO') return 'Сначала включите ручные корректировки и укажите причину.';
  if (error.code === 'MODE_MANUAL')
    return 'В аварийном MANUAL автоматика приостановлена. Сначала верните AUTO.';
  return 'Изменение не применилось. Проверьте состояние и повторите расчёт.';
}

/** One user gesture prepares a candidate; only material consequences open an extra review. */
export function useAssistedCorrection() {
  const queryClient = useQueryClient();
  const state = useAssistedState();
  const pendingGesture = useRef(false);
  const [proposal, setProposal] = useState<AssistedProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: assistedStateQueryKey }),
      queryClient.invalidateQueries({ queryKey: planQueryKey }),
      queryClient.invalidateQueries({ queryKey: requestsQueryKey }),
      queryClient.invalidateQueries({ queryKey: liveQueryKey }),
    ]);
  const fail = async (cause: unknown) => {
    const updated = proposalFromError(cause);
    if (updated) setProposal(updated);
    else setProposal((current) => (current ? { ...current, canApply: false } : null));
    setError(updated ? null : message(cause));
    await refresh();
  };
  const prepare = useMutation({
    mutationFn: async ({
      change,
      reviewOnly = false,
    }: {
      change: AssistedChange;
      reviewOnly?: boolean;
    }) => {
      const current = await queryClient.fetchQuery({
        queryKey: assistedStateQueryKey,
        queryFn: getAssistedState,
        staleTime: 0,
      });
      const candidate = await prepareCorrection(change, current);
      if (!candidate.canApply || candidate.requiresConfirmation || reviewOnly) return candidate;
      try {
        await applyCorrection(candidate, false);
        return null;
      } catch (cause) {
        const updated = proposalFromError(cause);
        if (updated) return updated;
        throw cause;
      }
    },
    onMutate: () => setError(null),
    onSuccess: async (candidate) => {
      await refresh();
      setProposal(candidate);
    },
    onError: fail,
    onSettled: () => {
      pendingGesture.current = false;
    },
  });
  const apply = useMutation({
    mutationFn: (candidate: AssistedProposal) =>
      applyCorrection(candidate, candidate.requiresConfirmation),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await refresh();
      setProposal(null);
    },
    onError: fail,
    onSettled: () => {
      pendingGesture.current = false;
    },
  });
  const cancel = useMutation({
    mutationFn: (candidate: AssistedProposal) => cancelCorrection(candidate.proposalId),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await refresh();
      setProposal(null);
    },
    onError: fail,
    onSettled: () => {
      pendingGesture.current = false;
    },
  });
  const busy = prepare.isPending || apply.isPending || cancel.isPending;
  const begin = (action: () => void) => {
    // Two events can arrive before React renders a disabled button.
    if (pendingGesture.current || busy) return;
    pendingGesture.current = true;
    action();
  };
  return {
    state,
    proposal,
    error,
    busy,
    change: (change: AssistedChange) => {
      begin(() => prepare.mutate({ change }));
    },
    reviewPending: () => {
      if (!busy && state.data?.pendingProposal) {
        setError(null);
        setProposal(state.data.pendingProposal);
      }
    },
    confirm: () => {
      if (proposal?.canApply) begin(() => apply.mutate(proposal));
    },
    cancel: () => {
      if (proposal) begin(() => cancel.mutate(proposal));
    },
    recalculate: () => {
      if (proposal) begin(() => prepare.mutate({ change: proposal.change, reviewOnly: true }));
    },
  };
}
