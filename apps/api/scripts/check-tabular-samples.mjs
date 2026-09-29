import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = 'http://localhost:8000';
const root = '/Users/mike/Projects/LCT/LCT_smart_router';

// local dev creds from .env (never printed)
const envText = readFileSync(resolve(root, '.env'), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const email = env.DISPATCHER_EMAIL;
const password = env.DISPATCHER_PASSWORD;

const signIn = async () => {
  const r = await fetch(`${base}/api/v1/auth/dispatcher/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (r.status !== 201) throw new Error(`sign-in failed: ${r.status}`);
  const body = await r.json();
  return body.token;
};

const files = [
  ['01-calm-day-east.csv', 'auto', 'auto'],
  ['02-mkad-outskirts-day.tsv', 'auto', 'auto'],
  ['03-storm-tuesday-south.xlsx', 'auto', 'auto'],
  ['04-light-day-east-utf8.csv', 'auto', 'auto'],
];

const token = await signIn();
console.log('signed in OK');
let failures = 0;
for (const [name, encoding, delimiter] of files) {
  const payloadBase64 = readFileSync(resolve(root, 'data/samples', name)).toString('base64');
  const r = await fetch(`${base}/api/v1/dispatch/data/tabular/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ fileName: name, payloadBase64, encoding, delimiter }),
  });
  if (r.status !== 201) {
    failures++;
    console.log(`FAIL ${name}: analyze HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    continue;
  }
  const body = await r.json();
  const t = body.table ?? body;
  const headers = (t.headers ?? []).join(' | ');
  const rowCount = (t.rows ?? []).length;
  console.log(
    `${name}: HTTP 201, format=${t.format}, encoding=${t.encoding}, delimiter=${JSON.stringify(t.delimiter)}, rows=${rowCount}`,
  );
  console.log(`   headers: ${headers}`);
  const mapped = body.detectedColumns ?? body.columns ?? null;
  if (mapped) console.log(`   detected columns: ${JSON.stringify(mapped)}`);
  if (rowCount < 8) {
    failures++;
    console.log(`   FAIL: too few rows`);
  }
}
console.log(failures ? `FAILURES: ${failures}` : 'LIVE ANALYZE OK FOR ALL SAMPLES');
process.exit(failures ? 1 : 0);
