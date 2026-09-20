import { z } from 'zod';

/**
 * The exact eight keys a knowledge article's front-matter may declare
 * (docs/knowledge/README.md, "Контракт фронт-маттера"). Nothing more, nothing less: an
 * unknown key is as much a contract break as a missing one -- it is usually a typo that
 * silently shadowed the key the author meant to set.
 */
export const frontMatterSchema = z
  .object({
    id: z.string().trim().min(1),
    segment: z.enum(['client', 'engineer', 'dispatcher']),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)),
    actions: z.array(z.string().trim().min(1)),
    related: z.array(z.string().trim().min(1)),
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date, YYYY-MM-DD'),
  })
  .strict();

export type FrontMatter = z.infer<typeof frontMatterSchema>;

export interface ParsedArticle {
  readonly frontMatter: FrontMatter;
  /** Everything after the closing `---`, unsplit. */
  readonly body: string;
}

const DELIMITER = '---';

/**
 * Parses and validates one article's front-matter.
 *
 * A hand-rolled parser rather than a YAML dependency: the contract fixes exactly eight
 * scalar/array keys, and a general YAML parser would accept shapes -- multi-line
 * strings, nested maps, anchors, flow mappings -- the corpus must never use. Adding one
 * would only widen the ways a malformed article could slip past this check unnoticed.
 *
 * Throws on anything short of a fully valid block: no opening or closing `---`, a line
 * that is not `key: value`, a repeated key, an unknown key, a missing key, or a value
 * shaped wrong for its key (a scalar key given `[...]`, or vice versa). The caller (the
 * indexer) additionally checks `segment` against the directory the file lives in --
 * that check needs the file path, which is not part of the file's own content.
 */
export function parseFrontMatter(source: string): ParsedArticle {
  const lines = source.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== DELIMITER) {
    throw new Error('must start with a "---" front-matter block');
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closingIndex === -1) {
    throw new Error('front-matter block is opened with "---" but never closed');
  }

  const fields = new Map<string, string | string[]>();
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`front-matter line ${index + 1} is not "key: value": "${line}"`);
    }
    const key = line.slice(0, separator).trim();
    if (fields.has(key)) {
      throw new Error(`front-matter key "${key}" is repeated`);
    }
    fields.set(key, parseValue(line.slice(separator + 1).trim(), key));
  }

  const parsed = frontMatterSchema.safeParse(Object.fromEntries(fields));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`front-matter is invalid: ${issues}`);
  }

  return { frontMatter: parsed.data, body: lines.slice(closingIndex + 1).join('\n') };
}

function parseValue(raw: string, key: string): string | string[] {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) {
      throw new Error(`front-matter key "${key}" opens "[" but the line never closes it`);
    }
    const inner = raw.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim()));
  }
  return unquote(raw);
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}
