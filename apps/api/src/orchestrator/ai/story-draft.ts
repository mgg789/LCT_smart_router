import { z } from 'zod';

/** Fields the new-request form can show before the client confirms them. */
export interface StoryFields {
  readonly problem: string;
  readonly contactName: string;
  readonly email: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly address: string;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const storyGapSchema = z.object({
  problem: z.string().optional(),
  contactName: z.string().max(80).optional(),
  email: z.string().max(120).optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  address: z.string().max(240).optional(),
});

/** Pulls one JSON object out of a model reply, including a fenced block. */
export function parseModelJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Fills only empty fields from a schema-checked model reply.
 * A window is kept only when the source itself has a time signal.
 * A name, email or address must still occur in the source text.
 */
export function mergeStoryGaps(
  current: StoryFields,
  model: unknown,
  source: string,
  problems: readonly string[],
): StoryFields {
  const parsed = storyGapSchema.safeParse(model);
  if (!parsed.success) return current;
  const next = { ...current };
  const data = parsed.data;
  if (!next.problem && data.problem && problems.includes(data.problem)) {
    next.problem = data.problem;
  }
  if (!next.contactName && data.contactName && wordsInSource(data.contactName, source)) {
    next.contactName = data.contactName.trim().slice(0, 80);
  }
  if (!next.email && data.email && source.toLowerCase().includes(data.email.trim().toLowerCase())) {
    next.email = data.email.trim();
  }
  if (!next.address && data.address && wordsInSource(data.address, source)) {
    next.address = data.address.trim().slice(0, 240);
  }
  const timeSignal = /\d|утр|вечер|обед|час|до|после/i.test(source);
  if (
    timeSignal &&
    !next.windowStart &&
    !next.windowEnd &&
    data.windowStart &&
    data.windowEnd &&
    CLOCK.test(data.windowStart) &&
    CLOCK.test(data.windowEnd) &&
    data.windowStart < data.windowEnd
  ) {
    next.windowStart = data.windowStart;
    next.windowEnd = data.windowEnd;
  }
  return next;
}

/**
 * Always-returned draft. A missing topic becomes «Другое...», a missing
 * address keeps the raw text, and a missing window stays empty.
 */
export function finishStoryDraft(fields: StoryFields, source: string): StoryFields {
  return {
    problem: fields.problem || 'Другое...',
    contactName: fields.contactName || 'Клиент',
    email: fields.email,
    windowStart: fields.windowStart,
    windowEnd: fields.windowEnd,
    address: fields.address || source.trim().slice(0, 240),
  };
}

function wordsInSource(value: string, source: string): boolean {
  const words = value.toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) ?? [];
  if (words.length === 0) return false;
  const hay = source.toLowerCase();
  return words.some((word) => hay.includes(word));
}
