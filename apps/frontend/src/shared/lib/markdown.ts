/**
 * The little of Markdown an assistant answer actually uses.
 *
 * Parsed into a tree rather than turned into HTML: nothing here ever reaches
 * `dangerouslySetInnerHTML`, so a model cannot put markup — or a script — into
 * the dispatcher's page by writing it in its reply. Anything the grammar below
 * does not cover stays visible as the literal text the model wrote, which is the
 * honest outcome: a stray asterisk is shown, not swallowed.
 */

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string };

export type BlockNode =
  | { kind: 'heading'; level: 1 | 2 | 3; inline: InlineNode[] }
  | { kind: 'paragraph'; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] };

/**
 * Splits one line into runs.
 *
 * Order matters: code spans are taken first so the asterisks inside one are kept
 * as written, then bold before italic, because `**` would otherwise be read as
 * two empty italics.
 */
export function parseInline(line: string): InlineNode[] {
  const out: InlineNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/;
  let rest = line;

  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match || match.index === undefined) break;

    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: 'bold', text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: 'bold', text: match[3] });
    else if (match[4] !== undefined) out.push({ kind: 'italic', text: match[4] });
    else if (match[5] !== undefined) out.push({ kind: 'italic', text: match[5] });

    rest = rest.slice(match.index + match[0].length);
  }

  if (rest.length > 0) out.push({ kind: 'text', text: rest });
  return out;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Groups lines into blocks.
 *
 * Consecutive lines of running text join into one paragraph, the way Markdown
 * treats a soft wrap, and a blank line ends it. A list runs for as long as its
 * own marker keeps appearing.
 */
export function parseMarkdown(source: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
      list = null;
    }
  };

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      closeParagraph();
      closeList();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2]),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet?.[1] !== undefined || numbered?.[1] !== undefined) {
      closeParagraph();
      const ordered = numbered?.[1] !== undefined;
      const text = (ordered ? numbered?.[1] : bullet?.[1]) ?? '';
      if (list && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push(text);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeParagraph();
  closeList();
  return blocks;
}
