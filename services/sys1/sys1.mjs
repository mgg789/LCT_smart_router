#!/usr/bin/env node
/**
 * Sys1 — server-side stand-in for the local System one gateway (jev-local).
 *
 * The assistant contour talks to a tiny typed decision API (`/v1/choice`, `/v1/noul`)
 * that on a developer machine is served by jev-local (a local MLX model). A server
 * has no such model, so this service answers the same contract from a chat
 * completion endpoint (the OpenRouter mirror in the demo contour) instead:
 *
 *   POST /v1/noul   { state, question, criteria?{false,true} } -> { noul, confidence }
 *   POST /v1/choice { state, question, options[] }             -> { choice, confidence }
 *   GET  /health                                               -> { ok, service, ready }
 *
 * Configuration (environment):
 *   SYS1_LLM_BASE_URL  OpenAI-compatible base URL, e.g. https://openrouter.droidje.com/api/v1
 *   SYS1_LLM_TOKEN     Value of the X-Proxy-Token header the mirror expects
 *   SYS1_MODEL         Model slug (default: typesafe/jev-router — the actual
 *                      System One model; it self-routes and balances cost)
 *   SYS1_PORT          Listen port (default 12444, same as jev-local)
 *
 * An unset base URL or a failed upstream call answers 503: the application treats
 * "System one недоступен" as its documented degradation path and never as a pass.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.SYS1_PORT ?? 12444);
const BASE_URL = (process.env.SYS1_LLM_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.SYS1_LLM_TOKEN ?? '';
const MODEL = process.env.SYS1_MODEL ?? 'typesafe/jev-router';
const LLM_TIMEOUT_MS = Number(process.env.SYS1_LLM_TIMEOUT_MS ?? 12_000);
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

/** Pulls the first JSON object out of a model answer; models decorate JSON with prose. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [fenced?.[1], text]) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function askLLM(userContent, systemInstruction) {
  if (!BASE_URL) {
    throw Object.assign(new Error('SYS1_LLM_BASE_URL is not configured'), { status: 503 });
  }
  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-proxy-token': TOKEN,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (error) {
    throw Object.assign(new Error(`LLM unreachable: ${error?.message ?? 'unknown'}`), {
      status: 503,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`LLM HTTP ${response.status}`), { status: 502 });
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(text);
  if (parsed === null) {
    throw Object.assign(new Error('LLM answer is not JSON'), { status: 502 });
  }
  return parsed;
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
    const state = typeof input.state === 'string' ? input.state : JSON.stringify(input.state ?? '');
    const question = typeof input.question === 'string' ? input.question : '';
    const isChoice = url.pathname === '/v1/choice';
    const systemInstruction = isChoice
      ? 'Ты — быстрый классификатор System one. Тебе дают состояние, вопрос и пронумерованные ' +
        'варианты. Выбери ровно один вариант, лучший по вопросу, и ответь СТРОГО одним ' +
        'JSON-объектом без пояснений: {"choice":"<точный текст выбранного варианта>"}'
      : 'Ты — быстрый классификатор System one. Тебе дают состояние и вопрос; оцени ' +
        'вероятность истинности ответа «да» числом от 0 до 1 и ответь СТРОГО одним ' +
        'JSON-объектом без пояснений: {"noul":<число от 0 до 1>}';

    const userParts = [`состояние:\n${state}`, `вопрос:\n${question}`];
    if (isChoice) {
      const options = Array.isArray(input.options) ? input.options.filter((o) => typeof o === 'string') : [];
      userParts.push(`варианты:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`);
    } else if (input.criteria && typeof input.criteria === 'object') {
      userParts.push(
        `интерпретация: false — ${input.criteria.false ?? 'неверно'}; true — ${input.criteria.true ?? 'верно'}`,
      );
    }

    const answer = await askLLM(userParts.join('\n\n'), systemInstruction);
    if (isChoice) {
      const options = Array.isArray(input.options) ? input.options.filter((o) => typeof o === 'string') : [];
      let choice = typeof answer.choice === 'string' ? answer.choice.trim() : '';
      // Models sometimes echo the list numbering or paraphrase; snap the answer back
      // to the exact option text the application matches on.
      if (choice && !options.includes(choice)) {
        const bare = choice.replace(/^\d+[.)]\s*/, '');
        const exact = options.find((o) => o === bare);
        const contains = options.filter((o) => o.includes(bare) || bare.includes(o));
        if (exact) choice = exact;
        else if (contains.length === 1) choice = contains[0];
      }
      if (!choice) {
        send(res, 502, { error: 'LLM returned no choice' });
        return;
      }
      send(res, 200, { choice, confidence: 1 });
      return;
    }
    const raw = answer.noul;
    const noul = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(noul)) {
      send(res, 502, { error: 'LLM returned no noul' });
      return;
    }
    send(res, 200, { noul: Math.min(1, Math.max(0, noul)), confidence: 1 });
  } catch (error) {
    send(res, error?.status ?? 503, { error: error?.message ?? 'sys1 unavailable' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    `sys1 listening on :${PORT}, model=${MODEL}, base=${BASE_URL || '(not configured)'}\n`,
  );
});
