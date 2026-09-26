import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createVisibleAnswerFilter } from '../../src/ai/provider/visible-answer';

describe('visible answer filter', () => {
  it('keeps ordinary text, including a split chunk', () => {
    const filter = createVisibleAnswerFilter();
    assert.equal(filter.push('Гото'), 'Гото');
    assert.equal(filter.push('во.'), 'во.');
    assert.equal(filter.finish(), '');
  });

  it('drops a think span even when the tags arrive in pieces', () => {
    const filter = createVisibleAnswerFilter();
    assert.equal(filter.push('Ответ: <thi'), 'Ответ: ');
    assert.equal(filter.push('nk>черновик</thi'), '');
    assert.equal(filter.push('nk> готово'), ' готово');
    assert.equal(filter.finish(), '');
  });

  it('discards an unclosed think span', () => {
    const filter = createVisibleAnswerFilter();
    assert.equal(filter.push('<think>only the scratchpad'), '');
    assert.equal(filter.finish(), '');
  });
});
