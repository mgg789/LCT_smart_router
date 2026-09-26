import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFrontMatter } from '../../src/ai/knowledge/front-matter';

const validSource = [
  '---',
  'id: disp-01-day-shape',
  'segment: dispatcher',
  'title: Форма рабочего дня',
  'summary: Одна фраза, которую можно процитировать.',
  'tags: [live, день, старт]',
  'actions: [get_day_state, get_live_view]',
  'related: [disp-02-reading-the-plan]',
  'updated: 2026-09-20',
  '---',
  '',
  '## Первый раздел',
  '',
  'Текст первого раздела.',
].join('\n');

describe('knowledge front-matter parser', () => {
  it('parses a valid block into typed fields and leaves the body untouched', () => {
    const { frontMatter, body } = parseFrontMatter(validSource);
    assert.equal(frontMatter.id, 'disp-01-day-shape');
    assert.equal(frontMatter.segment, 'dispatcher');
    assert.equal(frontMatter.title, 'Форма рабочего дня');
    assert.equal(frontMatter.summary, 'Одна фраза, которую можно процитировать.');
    assert.deepEqual(frontMatter.tags, ['live', 'день', 'старт']);
    assert.deepEqual(frontMatter.actions, ['get_day_state', 'get_live_view']);
    assert.deepEqual(frontMatter.related, ['disp-02-reading-the-plan']);
    assert.equal(frontMatter.updated, '2026-09-20');
    assert.match(body, /## Первый раздел/);
  });

  it('accepts an explicitly empty array', () => {
    const source = validSource.replace('actions: [get_day_state, get_live_view]', 'actions: []');
    const { frontMatter } = parseFrontMatter(source);
    assert.deepEqual(frontMatter.actions, []);
  });

  it('throws naming the missing key', () => {
    const source = validSource
      .split('\n')
      .filter((line) => !line.startsWith('summary:'))
      .join('\n');
    assert.throws(() => parseFrontMatter(source), /summary/);
  });

  it('throws on an unknown key instead of silently ignoring it', () => {
    const source = validSource.replace('updated: 2026-09-20', 'updated: 2026-09-20\nextra: oops');
    assert.throws(() => parseFrontMatter(source), /extra/);
  });

  it('throws when the block is never closed', () => {
    const source = validSource.replace('---\n\n## Первый', '\n## Первый');
    assert.throws(() => parseFrontMatter(source), /never closed/);
  });

  it('throws when the file does not start with a front-matter block', () => {
    assert.throws(() => parseFrontMatter('# just a heading\n'), /must start/);
  });

  it('throws on a malformed date', () => {
    const source = validSource.replace('updated: 2026-09-20', 'updated: 20.09.2026');
    assert.throws(() => parseFrontMatter(source), /updated/);
  });

  it('throws on an unclosed array', () => {
    const source = validSource.replace('tags: [live, день, старт]', 'tags: [live, день, старт');
    assert.throws(() => parseFrontMatter(source), /never closes/);
  });

  it('throws on a repeated key', () => {
    const source = validSource.replace(
      'updated: 2026-09-20',
      'updated: 2026-09-20\nupdated: 2026-09-21',
    );
    assert.throws(() => parseFrontMatter(source), /repeated/);
  });

  it('segment is validated against the closed set of three values', () => {
    const source = validSource.replace('segment: dispatcher', 'segment: admin');
    assert.throws(() => parseFrontMatter(source), /segment/);
  });
});
