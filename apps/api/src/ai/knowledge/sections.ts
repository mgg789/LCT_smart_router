import { createHash } from 'node:crypto';

const HEADING_PATTERN = /^##[ \t]+(.+?)[ \t]*$/;

export interface RawSection {
  readonly heading: string;
  readonly body: string;
}

/**
 * Splits an article body into its `##` sections.
 *
 * docs/knowledge/README.md fixes the chunking contract: front-matter is never its own
 * chunk (it travels with the first section instead), and every article is documented as
 * a flat run of `##` blocks with nothing else in between. Text before the first heading,
 * an empty section body, or a heading repeated within one file are therefore not
 * "unusual but tolerated" -- they are the same class of content bug as a missing
 * front-matter key, and are failed the same way: loudly, naming the file.
 */
export function splitSections(body: string, sourcePath: string): RawSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RawSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let sawTextBeforeFirstHeading = false;

  for (const line of lines) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading?.[1]) {
      if (current) {
        sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
      }
      current = { heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (!current) {
      if (line.trim() !== '') sawTextBeforeFirstHeading = true;
      continue;
    }
    current.lines.push(line);
  }
  if (current) {
    sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  }

  if (sawTextBeforeFirstHeading) {
    throw new Error(`${sourcePath}: has text before its first "##" section heading`);
  }
  if (sections.length === 0) {
    throw new Error(`${sourcePath}: has no "##" sections to index`);
  }
  const seenHeadings = new Set<string>();
  for (const section of sections) {
    if (seenHeadings.has(section.heading)) {
      throw new Error(`${sourcePath}: "##" heading "${section.heading}" is repeated`);
    }
    seenHeadings.add(section.heading);
    if (section.body === '') {
      throw new Error(`${sourcePath}: section "${section.heading}" has no content`);
    }
  }
  return sections;
}

export interface SectionChecksumInput {
  readonly segment: string;
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly actions: readonly string[];
  readonly updatedAt: number;
}

/**
 * Deterministic fingerprint of every column one `ai_documents` row carries except its
 * primary key. Two indexer runs over unchanged input must produce the same value --
 * that identity is what lets the indexer skip rewriting a section instead of comparing
 * each column by hand, and is exercised directly by the checksum-stability unit test.
 */
export function sectionChecksum(input: SectionChecksumInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        segment: input.segment,
        slug: input.slug,
        section: input.section,
        title: input.title,
        summary: input.summary,
        body: input.body,
        tags: input.tags,
        actions: input.actions,
        updatedAt: input.updatedAt,
      }),
    )
    .digest('hex');
}
