import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { finishStoryDraft, mergeStoryGaps, parseModelJson, type StoryFields } from './story-draft';

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
  readonly windowStartAt?: number;
  readonly windowEndAt?: number;
  readonly reason: string;
}

const MESSAGE_OPTIONS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Всё ли в порядке', text: 'Всё ли в порядке? Нужна короткая отметка по заявке.' },
  { label: 'Нужна отметка', text: 'Нужна отметка о прибытии или завершении визита.' },
  { label: 'Свяжитесь с диспетчером', text: 'Свяжитесь с диспетчером, если смена сегодня не состоится.' },
  { label: 'Сформулировать', text: '' },
];

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
        ? 'Почему план получился таким. Для каждого ограничения из контекста одно следствие: люди не на линии, окно, навык, пеший лимит, обед или политика, и как оно сдвинуло назначение, опоздание или пробег. Последнее предложение — только итог. Не пересказывай заголовок оценки. Не выдумывай числа и имена.'
        : 'Почему заявка назначена этому исполнителю или осталась без него. Для каждого ограничения из контекста одно следствие: навык, окно, занятость смены, дорога или политика. Последнее предложение — только итог. Не выдумывай.';
    return this.complete(
      [
        {
          role: 'system',
          content:
            'Ты объясняешь диспетчеру уже посчитанное решение. Пиши только факты из контекста и прямое следствие каждого факта. ' +
            'Форма: факт, как он повлиял, что из этого вышло. ' +
            'Запрещено: оценки людей («кто-то лучше или хуже»), утешения, вступления, повторы одной мысли и связки без нового факта. ' +
            'Не выдумывай числа, имена и причины. Если причины в контексте нет — одна фраза: в контексте причины нет. ' +
            'Три или четыре коротких предложения. Без списков и без рассуждений вслух.',
        },
        { role: 'user', content: `${ask}\n\nКонтекст:\n${packed}` },
      ],
      280,
    );
  }

  /**
   * Turns a free-text visit story into the form fields.
   * Rules read what is already written. System one picks only among those
   * candidates. One language-model call fills gaps and is checked by schema.
   * If that model is down, the draft still returns and does not invent a window.
   */
  async interpretStory(text: string): Promise<StoryDraft> {
    const source = text.trim().slice(0, 4_000);
    const hints = hintedProblems(source);
    let problem = hints.length === 1 ? (hints[0] ?? '') : '';
    if (hints.length > 1) {
      problem = (await this.pick(source, 'Какая тема ближе к тексту?', hints)) ?? '';
    }
    const emails = unique(source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
    let email = emails.length === 1 ? (emails[0] ?? '') : '';
    if (emails.length > 1) {
      email = (await this.pick(source, 'Какой email указал клиент?', emails)) ?? emails[0] ?? '';
    }
    const spoken = explicitWindow(source);
    const names = unique(source.match(/[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}/g) ?? []);
    let contactName = names.length === 1 ? (names[0] ?? '') : '';
    if (names.length > 1) {
      contactName = (await this.pick(source, 'Как зовут клиента?', names)) ?? '';
    }
    const { lines, places } = addressCandidates(source);
    let address = '';
    if (lines.length === 1) address = snapAddress(lines[0] ?? '', places);
    else if (lines.length > 1) {
      const picked = await this.pick(source, 'Какая строка является адресом визита?', lines);
      address = snapAddress(picked ?? lines[0] ?? '', places);
    }
    let fields: StoryFields = {
      problem,
      contactName,
      email,
      windowStart: spoken?.start ?? '',
      windowEnd: spoken?.end ?? '',
      address,
    };
    const nothingMatched =
      hints.length === 0 &&
      !spoken &&
      names.length === 0 &&
      lines.length === 0 &&
      emails.length === 0;
    if (
      !fields.problem ||
      !fields.contactName ||
      !fields.address ||
      !fields.windowStart ||
      nothingMatched
    ) {
      fields = await this.fillStoryGaps(source, fields);
    }
    const finished = finishStoryDraft(fields, source);
    return {
      problem: (PROBLEMS.find((item) => item === finished.problem) ?? 'Другое...') as StoryDraft['problem'],
      contactName: finished.contactName,
      email: finished.email,
      windowStart: finished.windowStart,
      windowEnd: finished.windowEnd,
      address: finished.address,
    };
  }

  /**
   * Picks one allowed alert action, then a window, a letter, a wait or an engineer
   * when that action needs one. The caller still applies it through alert.resolve.
   */
  async chooseAlert(input: {
    summary: string;
    actions: readonly string[];
    engineers: ReadonlyArray<{ id: string; label: string; facts?: string }>;
    windows?: ReadonlyArray<{
      label: string;
      windowStartAt: number;
      windowEndAt: number;
      facts: string;
    }>;
    minutes?: readonly number[];
  }): Promise<AlertChoice> {
    const actions = input.actions.filter((item) => item.length > 0);
    if (actions.length === 0) throw new SysError('VALIDATION_FAILED', 'У алерта нет вариантов.');
    const action =
      actions.length < 2
        ? actions[0]!
        : await this.choice(
            input.summary,
            'Какое действие выбрать? Верни id из списка. У крайних вариантов цена уже написана.',
            actions,
          );
    if (!actions.includes(action)) {
      throw new SysError('VALIDATION_FAILED', 'Модель выбрала действие вне списка.');
    }
    const engineerId = await this.chooseEngineer(action, input.summary, input.engineers);
    const window = await this.chooseWindow(action, input.summary, input.windows ?? []);
    const minutes = await this.chooseMinutes(action, input.summary, input.minutes ?? [15, 30, 60]);
    const reason =
      action === 'message' || action === 'message_remove'
        ? await this.chooseMessage(input.summary)
        : 'Вариант выбран System one из допустимого списка.';
    return {
      action,
      ...(engineerId ? { engineerId } : {}),
      ...(minutes ? { minutes } : {}),
      ...(window ? { windowStartAt: window.windowStartAt, windowEndAt: window.windowEndAt } : {}),
      reason,
    };
  }

  /**
   * One lever from simulations the server already ran.
   * An empty list means none of those runs improved the plan.
   */
  async planOptimization(input: {
    summary: string;
    levers: ReadonlyArray<{ id: string; label: string; detail: string }>;
  }): Promise<{ id: string; label: string; steps: string[] }> {
    if (input.levers.length === 0) {
      return { id: 'current', label: 'План уже оптимален', steps: ['План уже оптимален'] };
    }
    const state = [
      input.summary,
      'Числа до и после прогона. Выбери один рычаг. План пока не изменён.',
      ...input.levers.map((item) => `${item.label}: ${item.detail}`),
    ]
      .join('\n')
      .slice(0, 6_000);
    const label = await this.choice(
      state,
      'Какой один рычаг применить?',
      input.levers.map((item) => item.label),
    );
    const found = input.levers.find((item) => item.label === label) ?? input.levers[0];
    if (!found) {
      return { id: 'current', label: 'План уже оптимален', steps: ['План уже оптимален'] };
    }
    return { id: found.id, label: found.label, steps: [`${found.label}. ${found.detail}`] };
  }

  /**
   * Picks a prepared policy id. `catalogLines` are the same delta sentences
   * the optimize button shows. The caller publishes through policy.select.
   */
  async choosePolicy(
    summary: string,
    catalogLines: readonly string[] = [],
  ): Promise<{ id: string; label: string }> {
    const state = [summary, ...catalogLines].filter(Boolean).join('\n').slice(0, 6_000);
    const label = await this.choice(
      state,
      'Какая политика планирования лучше исправляет описанную слабость плана?',
      POLICIES.map((item) => item.label),
    );
    return (
      POLICIES.find((item) => item.label === label) ?? { id: 'balanced', label: 'Ровнее загрузка' }
    );
  }

  /**
   * System one base URL, scheme-checked. The endpoint is operator-configured
   * (JEV_API_URL, the validated env schema), and must stay an HTTP service:
   * a misconfigured URL must fail into the honest `not_configured` path instead
   * of reaching whatever other scheme the value carried.
   */
  private jevBase(): string {
    const raw = (process.env.JEV_API_URL ?? 'http://host.docker.internal:12444').replace(/\/$/, '');
    const scheme = new URL(raw).protocol;
    if (scheme !== 'http:' && scheme !== 'https:') {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one доступен только по HTTP(S).');
    }
    return raw;
  }

  private async chooseEngineer(
    action: string,
    summary: string,
    engineers: ReadonlyArray<{ id: string; label: string; facts?: string }>,
  ): Promise<string | undefined> {
    if (action !== 'add_engineer') return undefined;
    if (engineers.length === 0) {
      throw new SysError('VALIDATION_FAILED', 'Нет инженера вне линии с нужным навыком и регионом.');
    }
    if (engineers.length === 1) return engineers[0]?.id;
    const state = `${summary}\n\nКандидаты вне линии:\n${engineers
      .map((item) => `${item.label}: ${item.facts ?? 'загрузка не посчитана'}`)
      .join('\n')}`;
    const label = await this.choice(state, 'Кого вызвать на линию?', engineers.map((item) => item.label));
    const found = engineers.find((item) => item.label === label);
    if (!found) throw new SysError('VALIDATION_FAILED', 'Модель выбрала инженера вне списка.');
    return found.id;
  }

  private async chooseWindow(
    action: string,
    summary: string,
    windows: ReadonlyArray<{ label: string; windowStartAt: number; windowEndAt: number; facts: string }>,
  ): Promise<{ windowStartAt: number; windowEndAt: number } | undefined> {
    if (action !== 'move_window') return undefined;
    if (windows.length === 0) {
      throw new SysError('VALIDATION_FAILED', 'Сегодня нет окна, куда можно сдвинуть визит.');
    }
    if (windows.length === 1) return windows[0];
    const state = `${summary}\n\nСлоты на сегодня. В строке соседние заявки, загрузка и запас до опоздания.\n${windows
      .map((item) => `${item.label}: ${item.facts}`)
      .join('\n')}`;
    const label = await this.choice(state, 'Какое окно выбрать?', windows.map((item) => item.label));
    const found = windows.find((item) => item.label === label);
    if (!found) throw new SysError('VALIDATION_FAILED', 'Модель выбрала окно вне списка.');
    return found;
  }

  private async chooseMinutes(
    action: string,
    summary: string,
    allowed: readonly number[],
  ): Promise<number | undefined> {
    if (action !== 'extend') return undefined;
    const minutes = allowed.filter((item) => item > 0);
    if (minutes.length === 0) return 15;
    if (minutes.length === 1) return minutes[0];
    const labels = minutes.map((item) => `${item} минут`);
    const label = await this.choice(summary, 'На сколько продлить ожидание?', labels);
    return minutes[labels.indexOf(label)] ?? minutes[0];
  }

  /** Preset letter, or one language-model draft stored as the notification text. */
  private async chooseMessage(summary: string): Promise<string> {
    const label = await this.choice(
      summary,
      'Какое письмо отправить инженеру?',
      MESSAGE_OPTIONS.map((item) => item.label),
    );
    const found = MESSAGE_OPTIONS.find((item) => item.label === label) ?? MESSAGE_OPTIONS[0]!;
    if (found.label !== 'Сформулировать') return found.text;
    try {
      const text = await this.complete(
        [
          {
            role: 'system',
            content:
              'Напиши одно короткое сообщение инженеру по-русски, до 240 знаков. Не меняй план и не обещай новое назначение. Верни только текст сообщения.',
          },
          { role: 'user', content: summary.slice(0, 4_000) },
        ],
        120,
      );
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 8) return cleaned.slice(0, 240);
    } catch (error) {
      this.logger.warn(
        `Engineer message was not drafted: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return MESSAGE_OPTIONS[0]!.text;
  }

  /** System one choice that leaves the field empty when the call fails. */
  private async pick(
    state: string,
    question: string,
    options: readonly string[],
  ): Promise<string | null> {
    try {
      return await this.choice(state, question, options);
    } catch (error) {
      this.logger.warn(
        `System one choice skipped: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  /** One schema-checked model call. A failure keeps the fields already read. */
  private async fillStoryGaps(source: string, current: StoryFields): Promise<StoryFields> {
    try {
      const raw = await this.complete(
        [
          {
            role: 'system',
            content:
              'Заполни только пустые поля заявки из текста клиента. ' +
              `Тема только из списка: ${PROBLEMS.join(', ')}. ` +
              'Окно — два поля ЧЧ:ММ, и только если время есть в тексте. ' +
              'Имя и адрес копируй из текста, не придумывай. ' +
              'Ответ — один JSON с полями problem, contactName, email, windowStart, windowEnd, address.',
          },
          { role: 'user', content: `${source}\n\nУже прочитано:\n${JSON.stringify(current)}` },
        ],
        400,
      );
      return mergeStoryGaps(current, parseModelJson(raw), source, PROBLEMS);
    } catch (error) {
      this.logger.warn(
        `Story gap fill skipped: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return current;
    }
  }

  private async choice(
    state: string,
    question: string,
    options: readonly string[],
  ): Promise<string> {
    const uniqueOptions = [...new Set(options.map((item) => item.trim()).filter(Boolean))];
    if (uniqueOptions.length < 2) return uniqueOptions[0] ?? '';
    const base = this.jevBase();
    let response: Response;
    try {
      response = await fetch(`${base}/v1/choice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          state: state.slice(0, 6_000),
          question,
          options: uniqueOptions.slice(0, 12),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // No System one in this deployment (it runs on the operator's machine, not in
      // compose): a 503 lets the client keep the locally parsed fields, per the
      // documented degradation, instead of surfacing an internal error.
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one недоступен.');
    }
    if (!response.ok) {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one не ответил.');
    }
    const body = (await response.json()) as { choice?: unknown };
    if (typeof body.choice !== 'string' || !uniqueOptions.includes(body.choice)) {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'System one вернул вариант вне списка.');
    }
    return body.choice;
  }

  private async complete(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    maxTokens = 160,
  ): Promise<string> {
    // The same validated names the chat harness reads (env.schema.ts) -- a second
    // spelling here would leave the short-call path dead under a documented config.
    const key = process.env.LLM_TOKEN?.trim();
    const base = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    const model = process.env.LLM_MODEL?.trim() || 'deepseek-flash';
    if (!key) throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель не настроена.');
    const scheme = new URL(base).protocol;
    if (scheme !== 'https:' && scheme !== 'http:') {
      throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель доступна только по HTTP(S).');
    }
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
    if (!text)
      throw new SysError('SERVICE_NOT_CONFIGURED', 'Языковая модель вернула пустой текст.');
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

/** Topics the text itself names. System one does not see the rest of the catalogue. */
function hintedProblems(source: string): string[] {
  return unique(PROBLEM_HINTS.filter(([pattern]) => pattern.test(source)).map(([, label]) => label));
}

/** Street-like lines already present in the story. */
function addressCandidates(source: string): { lines: string[]; places: string[] } {
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
  const places = unique([
    ...(stated?.[1] ? [stated[1].trim()] : []),
    ...(street?.[0] ? [street[0].trim()] : []),
    ...(place?.[0] ? [place[0].trim()] : []),
    ...numbered,
  ]);
  const lines = unique([...places, ...clauses]).slice(0, 8);
  return { lines, places };
}

/** Keeps a street token when the chosen line merely contains it or is a time sentence. */
export function snapAddress(picked: string, places: readonly string[]): string {
  const known = places.find((place) => picked.includes(place));
  if (known) return known;
  const timeish =
    !picked || picked === 'не указан' || picked.includes('@') || /приезжайте|после/i.test(picked);
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
