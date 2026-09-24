import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('keeps plain text as one run', () => {
    expect(parseInline('обычный текст')).toEqual([{ kind: 'text', text: 'обычный текст' }]);
  });

  it('reads bold, and does not mistake it for two italics', () => {
    expect(parseInline('до **жирное** после')).toEqual([
      { kind: 'text', text: 'до ' },
      { kind: 'bold', text: 'жирное' },
      { kind: 'text', text: ' после' },
    ]);
  });

  it('reads italic in both spellings', () => {
    expect(parseInline('*раз* и _два_')).toEqual([
      { kind: 'italic', text: 'раз' },
      { kind: 'text', text: ' и ' },
      { kind: 'italic', text: 'два' },
    ]);
  });

  it('leaves the asterisks inside a code span alone', () => {
    expect(parseInline('поле `a**b` тут')).toEqual([
      { kind: 'text', text: 'поле ' },
      { kind: 'code', text: 'a**b' },
      { kind: 'text', text: ' тут' },
    ]);
  });

  it('shows an unpaired marker as the character it is', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
  });
});

describe('parseMarkdown', () => {
  it('joins a soft-wrapped paragraph into one block', () => {
    expect(parseMarkdown('первая строка\nвторая строка')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'первая строка вторая строка' }] },
    ]);
  });

  it('splits paragraphs on a blank line', () => {
    expect(parseMarkdown('раз\n\nдва')).toHaveLength(2);
  });

  it('reads headings by their level', () => {
    expect(parseMarkdown('## Заголовок')).toEqual([
      { kind: 'heading', level: 2, inline: [{ kind: 'text', text: 'Заголовок' }] },
    ]);
  });

  it('gathers a bullet list, keeping the inline marks in its items', () => {
    expect(parseMarkdown('- раз\n- **два**')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'раз' }], [{ kind: 'bold', text: 'два' }]],
      },
    ]);
  });

  it('keeps a numbered list apart from a bulleted one', () => {
    const blocks = parseMarkdown('1. раз\n2. два\n- три');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('ends a list when running text follows it', () => {
    const blocks = parseMarkdown('- пункт\nобычная строка');
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'paragraph']);
  });

  it('has nothing to show for an empty answer', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
