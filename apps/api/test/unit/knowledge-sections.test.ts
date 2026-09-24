import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sectionChecksum, splitSections } from '../../src/ai/knowledge/sections';

describe('knowledge section splitting', () => {
  it('splits a body into its ## sections, trimming each body', () => {
    const body = [
      '## Первый',
      '',
      'Текст первого раздела.',
      '',
      '## Второй',
      'Текст второго раздела.',
      'Вторая строка.',
    ].join('\n');
    const sections = splitSections(body, 'test.md');
    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.heading, 'Первый');
    assert.equal(sections[0]?.body, 'Текст первого раздела.');
    assert.equal(sections[1]?.heading, 'Второй');
    assert.equal(sections[1]?.body, 'Текст второго раздела.\nВторая строка.');
  });

  it('throws when there is text before the first heading', () => {
    const body = 'Вступление без заголовка.\n\n## Первый\n\nТекст.';
    assert.throws(() => splitSections(body, 'test.md'), /text before its first/);
  });

  it('throws when there are no ## headings at all', () => {
    assert.throws(() => splitSections('\n\n   \n', 'test.md'), /no "##"/);
  });

  it('throws when a heading is repeated', () => {
    const body = '## Раздел\n\nA\n\n## Раздел\n\nB';
    assert.throws(() => splitSections(body, 'test.md'), /repeated/);
  });

  it('throws when a section has no content', () => {
    const body = '## Раздел\n\n## Другой\n\nТекст.';
    assert.throws(() => splitSections(body, 'test.md'), /no content/);
  });
});

describe('knowledge section checksum', () => {
  const baseInput = {
    segment: 'dispatcher',
    slug: 'disp-01-day-shape',
    section: 'Первый',
    title: 'Заголовок',
    summary: 'Сводка.',
    body: 'Текст.',
    tags: ['live'],
    actions: ['get_day_state'],
    updatedAt: 1_789_459_200,
  };

  it('is stable across repeated calls with identical input', () => {
    const first = sectionChecksum(baseInput);
    const second = sectionChecksum({ ...baseInput });
    assert.equal(first, second);
  });

  it('changes when the body changes', () => {
    const first = sectionChecksum(baseInput);
    const second = sectionChecksum({ ...baseInput, body: 'Другой текст.' });
    assert.notEqual(first, second);
  });

  it('changes when tags order changes', () => {
    const first = sectionChecksum({ ...baseInput, tags: ['live', 'день'] });
    const second = sectionChecksum({ ...baseInput, tags: ['день', 'live'] });
    assert.notEqual(first, second);
  });

  it('changes when updatedAt changes even if nothing else does', () => {
    const first = sectionChecksum(baseInput);
    const second = sectionChecksum({ ...baseInput, updatedAt: baseInput.updatedAt + 86_400 });
    assert.notEqual(first, second);
  });
});
