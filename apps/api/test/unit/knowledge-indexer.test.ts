import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { collectSections } from '../../src/ai/knowledge/knowledge.indexer';

/** Builds a scratch `docs/knowledge`-shaped tree with only the segments/files given, so
 *  the directory-walk and cross-file rules (segment/directory match, duplicate id) can
 *  be exercised without touching the real corpus or a database. */
function buildCorpus(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-corpus-'));
  for (const segment of ['client', 'engineer', 'dispatcher']) {
    mkdirSync(join(root, segment), { recursive: true });
  }
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(root, relativePath), content, 'utf8');
  }
  return root;
}

const article = (id: string, segment: string, section = 'Раздел'): string =>
  [
    '---',
    `id: ${id}`,
    `segment: ${segment}`,
    'title: Заголовок',
    'summary: Сводка.',
    'tags: [live]',
    'actions: []',
    'related: []',
    'updated: 2026-09-20',
    '---',
    '',
    `## ${section}`,
    '',
    'Текст.',
  ].join('\n');

describe('knowledge corpus collection', () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('reads every article across the three segments into flat sections', async () => {
    const root = buildCorpus({
      'client/00-x.md': article('cli-00-x', 'client'),
      'engineer/00-x.md': article('eng-00-x', 'engineer'),
      'dispatcher/00-x.md': article('disp-00-x', 'dispatcher'),
    });
    roots.push(root);
    const { sections, filesRead } = await collectSections(root);
    assert.equal(filesRead, 3);
    assert.equal(sections.length, 3);
    assert.deepEqual(sections.map((s) => s.segment).sort(), ['client', 'dispatcher', 'engineer']);
  });

  it('fails the whole run when segment disagrees with its directory', async () => {
    const root = buildCorpus({
      // Front-matter claims "engineer" but the file lives under client/.
      'client/00-x.md': article('cli-00-x', 'engineer'),
    });
    roots.push(root);
    await assert.rejects(collectSections(root), /does not match its directory/);
  });

  it('fails the whole run on a duplicate front-matter id across files', async () => {
    const root = buildCorpus({
      'client/00-x.md': article('cli-00-x', 'client'),
      'client/01-y.md': article('cli-00-x', 'client'),
    });
    roots.push(root);
    await assert.rejects(collectSections(root), /already used by/);
  });

  it('fails loudly on a malformed article instead of skipping it', async () => {
    const root = buildCorpus({
      'client/00-good.md': article('cli-00-good', 'client'),
      'client/01-bad.md': '# no front-matter here\n\n## Section\n\ntext',
    });
    roots.push(root);
    await assert.rejects(collectSections(root), /client\/01-bad\.md/);
  });

  it('fails when a segment directory is missing entirely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-corpus-'));
    roots.push(root);
    // Only create two of the three required segment directories.
    mkdirSync(join(root, 'client'));
    mkdirSync(join(root, 'engineer'));
    await assert.rejects(collectSections(root), /segment directory is missing/);
  });
});
