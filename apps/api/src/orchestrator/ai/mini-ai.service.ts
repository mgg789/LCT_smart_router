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
    const packed = JSON.stringify(context).slice(0, 8_000);
    const ask =
      kind === 'plan'
        ? 'Объясни диспетчеру максимально коротко, почему план сейчас слабый и что из этого контекста важнее всего. Не выдумывай числа и имена.'
        : 'Объясни диспетчеру максимально коротко, почему выбрано именно это. Не выдумывай числа и имена.';
    return this.complete([
      {
        role: 'system',
        content:
          'Ты объясняешь уже посчитанный план полевых инженеров. Две-четыре коротких фразы по-русски. Только факты из контекста. Без списков, без рассуждений вслух.',
      },
      { role: 'user', content: `${ask}\n\nКонтекст:\n${packed}` },
    ]);
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
    const clocks = unique(
      [...source.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)].map(
        (match) => `${match[1]?.padStart(2, '0')}:${match[2]}`,
      ),
    ).filter((value) => isClock(value));
    const slots = visitWindows(clocks);
    const window = await this.choice(source, 'Какое окно визита просит клиент?', slots);
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
      'Какое действие лучше всего закрывает этот алерт? Выбери только из списка.',
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

  private async complete(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
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
        max_tokens: 160,
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
