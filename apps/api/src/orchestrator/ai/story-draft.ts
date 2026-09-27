import { z } from 'zod';
import { findWorkType } from '../requests/work-type.catalog';

/** Fields the new-request form can show before the client confirms them. */
export interface StoryFields {
  readonly workType?: string;
  readonly problem: string;
  readonly contactName: string;
  readonly email: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly address: string;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const storyGapSchema = z.object({
  workType: z.string().optional(),
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
  if (data.workType && findWorkType(data.workType)) next.workType = data.workType;
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
  const timeSignal = /\b\d{1,2}[:.]\d{2}\b|(?:с|после|до)\s*\d{1,2}\b|утр|вечер|обед|час/iu.test(
    source,
  );
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
 * address, identity and window stay empty for explicit user input.
 */
export function finishStoryDraft(fields: StoryFields, _source: string): StoryFields {
  return {
    problem: fields.problem || 'Другое...',
    contactName: fields.contactName,
    email: fields.email,
    windowStart: fields.windowStart,
    windowEnd: fields.windowEnd,
    address: fields.address,
  };
}

function wordsInSource(value: string, source: string): boolean {
  const words = value.toLowerCase().match(/[a-zа-яё0-9]+/gi) ?? [];
  if (words.length === 0) return false;
  const hay = source.toLowerCase();
  const sourceWords = new Set(hay.match(/[a-zа-яё0-9]+/gi) ?? []);
  return words.every((word) => sourceWords.has(word));
}
