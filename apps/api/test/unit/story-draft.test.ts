import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishStoryDraft,
  mergeStoryGaps,
  parseModelJson,
} from '../../src/orchestrator/ai/story-draft';

const PROBLEMS = ['Интернет не работает', 'Другое...'];
const empty = {
  problem: '',
  contactName: '',
  email: '',
  windowStart: '',
  windowEnd: '',
  address: '',
};

test('a gap fill keeps only fields the text already supports', () => {
  const source = 'Анна, интернет не работает, адрес Ленина 4, с 13 до 16, anna@example.com';
  const merged = mergeStoryGaps(
    empty,
    {
      problem: 'Интернет не работает',
      contactName: 'Анна',
      email: 'anna@example.com',
      windowStart: '13:00',
      windowEnd: '16:00',
      address: 'Ленина 4',
    },
    source,
    PROBLEMS,
  );
  assert.equal(merged.problem, 'Интернет не работает');
  assert.equal(merged.contactName, 'Анна');
  assert.equal(merged.windowStart, '13:00');
  assert.equal(merged.address, 'Ленина 4');
});

test('a model window is dropped when the text has no time', () => {
  const merged = mergeStoryGaps(
    empty,
    { problem: 'Выдумка', windowStart: '10:00', windowEnd: '12:00', address: 'Ленина 4' },
    'Почините роутер на Ленина',
    PROBLEMS,
  );
  assert.equal(merged.problem, '');
  assert.equal(merged.windowStart, '');
  assert.equal(merged.address, '');
});

test('a missing model still leaves a draft without an invented window', () => {
  const finished = finishStoryDraft(empty, 'просто текст без часов');
  assert.equal(finished.problem, 'Другое...');
  assert.equal(finished.contactName, '');
  assert.equal(finished.address, '');
  assert.equal(finished.windowStart, '');
  assert.equal(finished.windowEnd, '');
});

test('fenced model json is readable', () => {
  assert.deepEqual(parseModelJson('```json\n{"problem":"Другое..."}\n```'), {
    problem: 'Другое...',
  });
});

test('a house number cannot justify a time window or an invented identity', () => {
  const source =
    'У меня авария интернет вообще не работает проспект вернадского 11, я виктор михайленко, надо срочно';
  const result = mergeStoryGaps(
    empty,
    {
      workType: 'outage',
      problem: 'Авария',
      contactName: 'Виктор Михайленко',
      address: 'проспект вернадского 11',
      windowStart: '11:00',
      windowEnd: '13:00',
    },
    source,
    ['Авария'],
  );
  assert.equal(result.workType, 'outage');
  assert.equal(result.contactName, 'Виктор Михайленко');
  assert.equal(result.address, 'проспект вернадского 11');
  assert.equal(result.windowStart, '');
  assert.equal(
    mergeStoryGaps(empty, { contactName: 'Виктор Петров', workType: 'invented' }, source, [])
      .contactName,
    '',
  );
  assert.equal(mergeStoryGaps(empty, { workType: 'invented' }, source, []).workType, undefined);
});
