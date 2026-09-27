import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsxText, messages, readCatalog } from './source.mjs';

test('finds Russian copy, English JSX, accessible labels and templates', () => {
  for (const source of [
    'const x="Сохранить";',
    '<button>Save</button>',
    '<input aria-label="Search"/>',
    '<input aria-label={"Search"}/>',
    '<p>{"Hello"}</p>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Source-code fixture, not interpolation.
    'const a=`Заявок: ${count}`;',
  ])
    assert.equal(messages(source, 'a.tsx').messages.length, 1, source);
});
test('leaves protocol keys, types, URLs, classes, regexes and comments alone', () => {
  assert.equal(
    messages(
      'type X="Авария"; const x={"Русский ключ": 1}; /* Слова */ const p=/Город/; <div className="flex bg-white" data-testid="form"/>',
      'a.tsx',
    ).messages.length,
    0,
  );
});
test('preserves JSX sentence whitespace and parses data-only catalogues', () => {
  assert.equal(jsxText('\n  Один\n  два\n'), 'Один два');
  assert.equal(jsxText(' Было: '), ' Было: ');
  assert.deepEqual(readCatalog("export const ru = {'key': 'Текст'} as const;"), { key: 'Текст' });
});
