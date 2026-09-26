#!/usr/bin/env node
/**
 * Sys1 — server-side stand-in for the developer's local System one gateway
 * (jev-local). Both speak the same tiny typed contract:
 *
 *   POST /v1/noul   { state, question, criteria?{false,true} } -> { noul, confidence }
 *   POST /v1/choice { state, question, options[] }             -> { choice, confidence }
 *   GET  /health                                               -> { ok, service, ready }
 *
 * The answers come from the real System One decision model (typesafe/jev-1.13) on
 * OpenRouter through its decisions endpoint (`POST /api/alpha/decisions`) — a
 * different API type from chat completions: questions travel as a record of
 * `{type, instructions, criteria}` and answers come back as a record keyed by the
 * question id. In the demo contour requests reach OpenRouter through the mirror
 * (X-Proxy-Token auth; the provider key stays injected server-side).
 *
 * Configuration (environment):
 *   SYS1_LLM_BASE_URL  OpenRouter base (default https://openrouter.ai/api — the
 *                      mirror in the demo contour)
 *   SYS1_LLM_TOKEN     Value of the X-Proxy-Token header the mirror expects
 *   SYS1_MODEL         Decision model (default typesafe/jev-1.13)
 *   SYS1_PORT          Listen port (default 12444, same as jev-local)
 *
 * An unset base URL or a failed upstream call answers 503: the application treats
 * "System one недоступен" as its documented degradation path and never as a pass.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.SYS1_PORT ?? 12444);
const BASE_URL = (process.env.SYS1_LLM_BASE_URL ?? 'https://openrouter.ai/api').replace(/\/$/, '');
const TOKEN = process.env.SYS1_LLM_TOKEN ?? '';
const MODEL = process.env.SYS1_MODEL ?? 'typesafe/jev-1.13';
const DECISIONS_TIMEOUT_MS = Number(process.env.SYS1_LLM_TIMEOUT_MS ?? 30_000);
const BODY_LIMIT = 64 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json' };

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** One decisions call with a single question; returns the answer record. */
async function decide({ stateText, id, type, question, criteria }) {
  const base = new URL(BASE_URL);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw Object.assign(new Error('SYS1_LLM_BASE_URL must be http(s)'), { status: 503 });
  }
  let response;
  try {
    response = await fetch(`${base.origin}/api/alpha/decisions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-proxy-token': TOKEN,
      },
      body: JSON.stringify({
        model: MODEL,
        state: { text: stateText },
        questions: {
          [id]: { type, instructions: question, criteria },
        },
      }),
      signal: AbortSignal.timeout(DECISIONS_TIMEOUT_MS),
    });
  } catch (error) {
    throw Object.assign(new Error(`decisions unreachable: ${error?.message ?? 'unknown'}`), {
      status: 503,
    });
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({})))?.error?.message;
    throw Object.assign(new Error(`decisions HTTP ${response.status}${detail ? `: ${detail}` : ''}`), {
      status: 502,
    });
  }
  const body = await response.json();
  const answer = body?.answers?.[id];
  if (!answer || typeof answer !== 'object') {
    throw Object.assign(new Error('decisions answer is missing'), { status: 502 });
  }
  return answer;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, service: 'sys1', ready: Boolean(BASE_URL), model: MODEL });
      return;
    }
    if (req.method !== 'POST' || (url.pathname !== '/v1/noul' && url.pathname !== '/v1/choice')) {
      send(res, 404, { error: 'not found' });
      return;
    }
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const state =
      typeof input.state === 'string' ? input.state : JSON.stringify(input.state ?? '');
    const question = typeof input.question === 'string' ? input.question : '';
    const isChoice = url.pathname === '/v1/choice';

    if (isChoice) {
      const options = Array.isArray(input.options)
        ? input.options.filter((o) => typeof o === 'string' && o.length > 0)
        : [];
      if (options.length === 0) {
        send(res, 400, { error: 'options[] required for /v1/choice' });
        return;
      }
      // The decisions API takes choice criteria as a record keyed by the option
      // itself; a missing description degrades to the option text.
      const criteria = {};
      for (const option of options) {
        criteria[option] = input.criteria?.[option] ?? option;
      }
      const answer = await decide({
        stateText: state,
        id: 'choice',
        type: 'choice',
        question,
        criteria,
      });
      let choice = typeof answer.choice === 'string' ? answer.choice.trim() : '';
      // Snap the answer back to the exact option text the application matches on:
      // near-miss answers are resolved against the option list, ambiguous ones are
      // refused and degrade at the caller.
      if (choice && !options.includes(choice)) {
        const bare = choice.replace(/^\d+[.)]\s*/, '');
        const exact = options.find((o) => o === bare);
        const contains = options.filter((o) => o.includes(bare) || bare.includes(o));
        if (exact) choice = exact;
        else if (contains.length === 1) choice = contains[0];
      }
      if (!choice || !options.includes(choice)) {
        send(res, 502, { error: 'decision outside the option list' });
        return;
      }
      send(res, 200, {
        choice,
        probabilities: answer.probabilities ?? undefined,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : 1,
      });
      return;
    }

    const criteria =
      input.criteria && typeof input.criteria === 'object'
        ? { false: String(input.criteria.false ?? 'неверно'), true: String(input.criteria.true ?? 'верно') }
        : { false: 'неверно', true: 'верно' };
    const answer = await decide({
      stateText: state,
      id: 'noul',
      type: 'noul',
      question,
      criteria,
    });
    const raw = answer.noul;
    const noul = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(noul)) {
      send(res, 502, { error: 'decision returned no noul' });
      return;
    }
    send(res, 200, {
      noul: Math.min(1, Math.max(0, noul)),
      confidence: typeof answer.confidence === 'number' ? answer.confidence : 1,
    });
  } catch (error) {
    send(res, error?.status ?? 503, { error: error?.message ?? 'sys1 unavailable' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    `sys1 listening on :${PORT}, model=${MODEL}, base=${BASE_URL}\n`,
  );
});
