import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';

const PROBLEMS = [
  'Интернет не работает',
  'Починить роутер',
  'IP-телефония',
  'Подключение офиса',
  'Настроить Wi-Fi',
  'Другое...',
] as const;

const POLICIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'compact', label: 'Дешевле' },
  { id: 'fast', label: 'Быстрее до клиента' },
  { id: 'sla', label: 'Бережнее к окнам' },
  { id: 'balanced', label: 'Ровнее загрузка' },
  { id: 'eco', label: 'Короче пробег' },
  { id: 'covering', label: 'Полное покрытие' },
];

export interface StoryDraft {
  readonly problem: (typeof PROBLEMS)[number];
  readonly contactName: string;
  readonly email: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly address: string;
}

export interface AlertChoice {
  readonly action: string;
  readonly engineerId?: string;
  readonly minutes?: number;
  readonly reason: string;
}

/**
 * Two small model calls, neither of which writes a plan by itself.
 *
 * The language model only rephrases a context the server already has.
 * System one (local Jev: choice / noul) only picks an id from a list the
 * server built. Applying that id stays on the existing dispatcher operation.
 */
@Injectable()
export class MiniAiService {
  private readonly logger = new Logger(MiniAiService.name);

  /** Short Russian explanation. Throws when the language model is not configured. */
  async explain(kind: 'reasons' | 'plan', context: unknown): Promise<string> {
    const packed = JSON.stringify(context).slice(0, 12_000);
    const ask =
      kind === 'plan'
        ? 'Объясни, почему план получился именно таким. Назови ограничение, которое породило цифры: люди не на линии, окно, навык, пеший лимит, обед или политика. Не пересказывай заголовок оценки. Четыре-шесть коротких предложений. Не выдумывай числа и имена.'
        : 'Объясни, почему выбрали именно этого исполнителя или почему заявка осталась без него. Сравни с другими людьми, окном и дорогой из контекста. Не пересказывай список фактов дословно. Четыре-шесть коротких предложений. Не выдумывай.';
    return this.complete(
      [
        {
          role: 'system',
          content:
            'Ты объясняешь причину уже посчитанного решения диспетчеру. Связный русский текст, без списков и без рассуждений вслух. Если в контексте нет причины, так и скажи.',
        },
        { role: 'user', content: `${ask}\n\nКонтекст:\n${packed}` },
      ],
      280,
    );
  }

  /**
   * Turns a free-text visit story into the form fields.
   * Candidates come from the text; System one only picks among them.
   */
  async interpretStory(text: string): Promise<StoryDraft> {
    const source = text.trim().slice(0, 4_000);
    const problem = await this.choice(
      source,
      'Какая тема заявки ближе всего к тексту?',
      problemOptions(source),
    );
    const emails = unique(source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
    const email =
      emails.length === 0
        ? ''
        : emails.length === 1
          ? emails[0]
          : await this.choice(source, 'Какой email указал клиент?', emails);
    const spoken = explicitWindow(source) ?? (await this.modelWindow(source));
    const clocks = unique(
      [...source.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)].map(
        (match) => `${match[1]?.padStart(2, '0')}:${match[2]}`,
      ),
    ).filter((value) => isClock(value));
    const slots = visitWindows(clocks);
    const window = spoken
      ? `${spoken.start}–${spoken.end}`
      : await this.choice(source, 'Какое окно визита просит клиент?', slots);
    const [windowStart, windowEnd] = window.split('–');
    const names = unique(source.match(/[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}/g) ?? []);
    const contactName =
      names.length === 0
        ? ''
        : names.length === 1
          ? names[0]
          : await this.choice(source, 'Как зовут клиента?', [...names, 'не указано']);
    const clauses = source
      .split(/\n+|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/)
      .map((line) => line.trim())
      .filter((line) => line.length > 4 && line.length < 180 && !line.includes('@'));
    const street = source.match(
      /(?:ул\.?|улиц\p{L}*|проспект\p{L}*|пр-т|переул\p{L}*|шоссе|набережн\p{L}*|бульвар\p{L}*)[^,.\n]{0,48}/iu,
    );
    const place = source.match(/на\s+[А-ЯЁ][^,.\n]{2,48}/u);
    const numbered = [...source.matchAll(/(?:^|[^\p{L}\p{N}])([А-ЯЁ][а-яё]{2,}\s+\d+[а-яА-Я]?)/gu)].map(
      (match) => match[1] ?? '',
    );
    const stated = source.match(/адрес\s+([^,.\n]{3,48})/iu);
    const lines = unique([
      ...(stated?.[1] ? [stated[1].trim()] : []),
      ...(street?.[0] ? [street[0].trim()] : []),
      ...(place?.[0] ? [place[0].trim()] : []),
      ...numbered,
      ...clauses,
    ]).slice(0, 8);
    const pickedAddress =
      lines.length === 0
        ? ''
        : await this.choice(source, 'Какая строка является адресом визита?', [
            ...lines,
            'не указан',
          ]);
    const places = unique([
      ...(stated?.[1] ? [stated[1].trim()] : []),
      ...(street?.[0] ? [street[0].trim()] : []),
      ...(place?.[0] ? [place[0].trim()] : []),
      ...numbered,
    ]);
    const address = snapAddress(pickedAddress, places);
    return {
      problem: (PROBLEMS.find((item) => item === problem) ?? 'Другое...') as StoryDraft['problem'],
      contactName: contactName === 'не указано' ? '' : (contactName ?? ''),
      email: email ?? '',
      windowStart: windowStart || '10:00',
      windowEnd: windowEnd || '12:00',
      address: !address || address === 'не указан' ? '' : address,
    };
  }

  /**
   * Picks one allowed alert action. A second choice names an engineer when
   * the action needs one. The caller still applies it through alert.resolve.
   */
  async chooseAlert(input: {
    summary: string;
    actions: readonly string[];
    engineers: ReadonlyArray<{ id: string; label: string }>;
  }): Promise<AlertChoice> {
    const actions = input.actions.filter((item) => item.length > 0);
    if (actions.length < 2) {
      const only = actions[0];
      if (!only) throw new SysError('VALIDATION_FAILED', 'У алерта нет вариантов.');
      return { action: only, reason: 'Единственный допустимый вариант.' };
    }
    const action = await this.choice(
      input.summary,
      'Какое действие лучше закрывает алерт с учётом плюсов и минусов в контексте? Выбери только из списка.',
      actions,
    );
    if (!actions.includes(action)) {
      throw new SysError('VALIDATION_FAILED', 'Модель выбрала действие вне списка.');
    }
    let engineerId: string | undefined;
    if (action === 'add_engineer' && input.engineers.length >= 2) {
      const label = await this.choice(
        input.summary,
        'Кого из доступных инженеров вызвать?',
        input.engineers.map((item) => item.label),
      );
      engineerId = input.engineers.find((item) => item.label === label)?.id;
    } else if (action === 'add_engineer' && input.engineers.length === 1) {
      engineerId = input.engineers[0]?.id;
    }
    return {
      action,
      ...(engineerId ? { engineerId } : {}),
      ...(action === 'extend' ? { minutes: 30 } : {}),
      reason: 'Вариант выбран System one из допустимого списка.',
    };
  }

  /**
   * Several yes/no and choice calls. Windows and lunches are named as forbidden
   * in every question, and this method never returns those actions.
   */
  async planOptimization(input: {
    summary: string;
    currentPolicyId: string;
    currentPolicyLabel: string;
    manual: boolean;
    callCandidates: ReadonlyArray<{ id: string; label: string }>;
  }): Promise<{
    policyId: string;
    policyLabel: string;
    callEngineerId: string | null;
    restoreAuto: boolean;
    steps: string[];
  }> {
    const state = `${input.summary.slice(0, 4_000)}\nСейчас политика: ${input.currentPolicyLabel}. Окна клиентов и обеды менять нельзя.`;
    const steps: string[] = [];
    let policy = { id: input.currentPolicyId, label: input.currentPolicyLabel };
    if (await this.noul(state, 'Сменить политику планирования? Окна клиентов и обеды не трогать.')) {
      const label = await this.choice(
        state,
        'Какая политика лучше исправляет слабость, не меняя окна и обеды?',
        POLICIES.map((item) => item.label),
      );
      const found = POLICIES.find((item) => item.label === label);
      if (found && found.id !== input.currentPolicyId) {
        policy = found;
        steps.push(`Политика: ${found.label}`);
      }
    }
    let callEngineerId: string | null = null;
    if (
      input.callCandidates.length > 0 &&
      (await this.noul(state, 'Вызвать на линию ещё одного инженера? Окна и обеды не меняются.'))
    ) {
      const names = input.callCandidates.map((item) => item.label);
      const label =
        names.length === 1
          ? names[0]
          : await this.choice(state, 'Кого вызвать на линию?', [...names, 'Никого']);
      callEngineerId = input.callCandidates.find((item) => item.label === label)?.id ?? null;
      if (callEngineerId && label) steps.push(`Вызов: ${label}`);
    }
    const restoreAuto =
      input.manual &&
      (await this.noul(state, 'Вернуть автоматический план вместо ручного? Окна и обеды не менять.'));
    if (restoreAuto) steps.push('Возврат к автоматическому плану');
    if (steps.length === 0) steps.push('Без смены окон и обедов маршрут уже в лучшем доступном виде');
    return { policyId: policy.id, policyLabel: policy.label, callEngineerId, restoreAuto, steps };
  }

  /** Picks a prepared policy id. The caller publishes it through policy.select. */
  async choosePolicy(summary: string): Promise<{ id: string; label: string }> {
    const label = await this.choice(
      summary,
      'Какая политика планирования лучше исправляет описанную слабость плана?',
      POLICIES.map((item) => item.label),
    );
    return POLICIES.find((item) => item.label === label) ?? { id: 'balanced', label: 'Ровнее загрузка' };
  }

  private async choice(state: string, question: string, options: readonly string[]): Promise<string> {
    const uniqueOptions = [...new Set(options.map((item) => item.trim()).filter(Boolean))];
    if (uniqueOptions.length < 2) return uniqueOptions[0] ?? '';
    const base = (process.env.JEV_API_URL ?? 'http://host.docker.internal:12444').replace(/\/$/, '');
    const response = await fetch(`${base}/v1/choice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        state: state.slice(0, 6_000),
        question,
        options: uniqueOptions.slice(0, 12),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one не ответил.');
    }
    const body = (await response.json()) as { choice?: unknown };
    if (typeof body.choice !== 'string' || !uniqueOptions.includes(body.choice)) {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one вернул вариант вне списка.');
    }
    return body.choice;
  }

  /** True when System one leans to «да». A failed call means «нет», so nothing is applied. */
  private async noul(state: string, question: string): Promise<boolean> {
    const base = (process.env.JEV_API_URL ?? 'http://host.docker.internal:12444').replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/v1/noul`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          state: state.slice(0, 6_000),
          question,
          criteria: { false: 'нет', true: 'да' },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { noul?: unknown };
      return typeof body.noul === 'number' && body.noul >= 0.5;
    } catch (error) {
      this.logger.warn(`System one yes/no failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    }
  }

  /** Reads an hour range the regex missed. Empty when the model is down or the text has no clock. */
  private async modelWindow(source: string): Promise<{ start: string; end: string } | null> {
    if (!process.env.LLM_API_KEY?.trim()) return null;
    if (!/(до|после|утр|вечер|час|\d{1,2})/i.test(source)) return null;
    try {
      const text = await this.complete(
        [
          {
            role: 'system',
            content:
              'Из текста выпиши окно визита. Ответ строго в виде ЧЧ:ММ-ЧЧ:ММ. Если времени нет, ответь нет.',
          },
          { role: 'user', content: source.slice(0, 2_000) },
        ],
        24,
      );
      return explicitWindow(text.replace('-', ' до ').replace('–', ' до '));
    } catch {
      return null;
    }
  }

  private async complete(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    maxTokens = 160,
  ): Promise<string> {
    const key = process.env.LLM_API_KEY?.trim();
    const base = (process.env.LLM_API_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    const model = process.env.LLM_MODEL?.trim() || 'deepseek-flash';
    if (!key) throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель не настроена.');
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      this.logger.warn(`Language model HTTP ${response.status}`);
      throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель не ответила.');
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель вернула пустой текст.');
    return text;
  }
}

const PROBLEM_HINTS: ReadonlyArray<[RegExp, (typeof PROBLEMS)[number]]> = [
  [/wi-?fi|вай-?фай/i, 'Настроить Wi-Fi'],
  [/роутер/i, 'Починить роутер'],
  [/телефон/i, 'IP-телефония'],
  [/подключ/i, 'Подключение офиса'],
  [/интернет|нет сети/i, 'Интернет не работает'],
];

/** Narrows the topic list when the text already names one, and always leaves an escape. */
function problemOptions(source: string): string[] {
  const hinted = unique(
    PROBLEM_HINTS.filter(([pattern]) => pattern.test(source)).map(([, label]) => label),
  );
  const options = hinted.length > 0 ? [...hinted, 'Другое...'] : [...PROBLEMS];
  return options.length >= 2 ? options : [...PROBLEMS];
}

/** Keeps a street token when the chosen line merely contains it or is a time sentence. */
export function snapAddress(picked: string, places: readonly string[]): string {
  const known = places.find((place) => picked.includes(place));
  if (known) return known;
  const timeish = !picked || picked === 'не указан' || picked.includes('@') || /приезжайте|после/i.test(picked);
  if (timeish) return places[0] ?? '';
  return picked;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function isClock(value: string): boolean {
  const [hour, minute] = value.split(':').map(Number);
  return (
    hour !== undefined &&
    minute !== undefined &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

/**
 * A range the client already wrote, including «с 13 до 16» without minutes.
 * System one must not replace this with a nearby slot.
 */
export function explicitWindow(source: string): { start: string; end: string } | null {
  const range = source.match(
    /(?:с|c)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:до|–|-|—)\s*(\d{1,2})(?:[:.](\d{2}))?/i,
  );
  if (!range) return null;
  const start = clockOf(range[1], range[2]);
  const end = clockOf(range[3], range[4]);
  if (!start || !end || start >= end) return null;
  return { start, end };
}

function clockOf(hour: string | undefined, minute: string | undefined): string | null {
  if (!hour) return null;
  const value = `${hour.padStart(2, '0')}:${minute ?? '00'}`;
  return isClock(value) ? value : null;
}

/** A few concrete windows so System one picks a slot instead of inventing a clock. */
export function visitWindows(clocks: readonly string[]): string[] {
  if (clocks.length >= 2) return [`${clocks[0]}–${clocks[1]}`, '10:00–12:00', '14:00–16:00'];
  if (clocks.length === 1) {
    const hour = Number(clocks[0]?.split(':')[0] ?? 0);
    const end = `${String(Math.min(23, hour + 2)).padStart(2, '0')}:${clocks[0]?.slice(3) ?? '00'}`;
    return [`${clocks[0]}–${end}`, '10:00–12:00', '14:00–16:00'];
  }
  return ['09:00–12:00', '12:00–15:00', '15:00–18:00'];
}
