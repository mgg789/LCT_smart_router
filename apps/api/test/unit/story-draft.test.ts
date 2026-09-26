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
  assert.equal(merged.address, 'Ленина 4');
});

test('a missing model still leaves a draft without an invented window', () => {
  const finished = finishStoryDraft(empty, 'просто текст без часов');
  assert.equal(finished.problem, 'Другое...');
  assert.equal(finished.contactName, 'Клиент');
  assert.equal(finished.address, 'просто текст без часов');
  assert.equal(finished.windowStart, '');
  assert.equal(finished.windowEnd, '');
});

test('fenced model json is readable', () => {
  assert.deepEqual(parseModelJson('```json\n{"problem":"Другое..."}\n```'), {
    problem: 'Другое...',
  });
});
