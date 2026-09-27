/** A factual input source for one dispatcher explanation factor. */
export interface DispatcherExplanationSource {
  readonly kind: 'applied_plan' | 'current_request' | 'router_evidence';
  readonly id: string | null;
  readonly planRevision: number | null;
  readonly inputHash: string | null;
  readonly routerContextVersion: string | null;
  readonly recordedAt: number | null;
}

/** One typed, source-linked fact or calculation returned by a dispatcher read tool. */
export interface DispatcherExplanationFactor {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly basis: 'fact' | 'constraint_check' | 'calculation_outcome' | 'unknown';
  readonly source: DispatcherExplanationSource;
  readonly limitation?: string;
  readonly followUpQuestion: string;
  readonly followUpLink: string;
}

/** Builds a stable question link so the UI can place a focused follow-up in the draft. */
export function dispatcherFactorFollowUp(
  label: string,
  subject: string,
): { readonly question: string; readonly link: string } {
  const key = label.toLocaleLowerCase('ru-RU');
  const question =
    key.includes('дорог') || key.includes('путь')
      ? `Объясни источник и составляющие ${key} для ${subject}.`
      : key.includes('альтернатив') || key.includes('кандидат')
        ? `Покажи рассчитанные варианты для ${subject} и поясни разницу.`
        : `Уточни, что означает ${key} для ${subject}.`;
  return { question, link: `#assistant-question=${encodeURIComponent(question)}` };
}

/** Creates an explanation factor with a deterministic, entity-focused follow-up. */
export function dispatcherExplanationFactor(input: {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly basis: DispatcherExplanationFactor['basis'];
  readonly source: DispatcherExplanationSource;
  readonly subject: string;
  readonly limitation?: string;
}): DispatcherExplanationFactor {
  const followUp = dispatcherFactorFollowUp(input.label, input.subject);
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    basis: input.basis,
    source: input.source,
    ...(input.limitation ? { limitation: input.limitation } : {}),
    followUpQuestion: followUp.question,
    followUpLink: followUp.link,
  };
}
