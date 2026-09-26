/**
 * Setup kit for the dashboard MCP server: pin generation, the self-connecting
 * `setup.md` the dispatcher hands to their agent, and the browser download.
 *
 * Everything here is pure except [[downloadMcpSetupMd]] — the markdown is composed
 * on the client from values the dispatcher already sees (origin and pin); the server
 * never re-reveals the pin.
 */

const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A pin the dispatcher can actually read aloud: four groups of four, no ambiguous glyphs. */
export function generateMcpPin(): string {
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((value) => PIN_ALPHABET[value % PIN_ALPHABET.length]);
  return [0, 4, 8, 12].map((start) => chars.slice(start, start + 4).join('')).join('-');
}

export interface McpSetupInput {
  /** Dashboard origin the agent connects to, e.g. `https://navix.droidje.com`. */
  origin: string;
  endpoint: string;
  pin: string;
}

/** Human-facing tool names, short enough for the agent to read before acting. */
const TOOL_CATALOGUE: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: 'get_dispatcher_context',
    description: 'кто ты в этой системе, состояние рабочего дня, правила автономной работы',
  },
  {
    name: 'get_routing_principles',
    description: 'цели и жёсткие ограничения планирования, каталог политик',
  },
  {
    name: 'get_situation',
    description: 'текущая обстановка: статусы инженеров, открытые алерты, погода',
  },
  { name: 'get_plan', description: 'текущий план: маршруты, остановки, назначения' },
  {
    name: 'get_plan_explanations',
    description: 'подробные факторы решателя: почему так, почему не иначе',
  },
  { name: 'list_requests', description: 'все заявки дня с деталями каждой' },
  { name: 'get_request', description: 'одна заявка: детали и история изменений условий' },
  { name: 'list_alerts', description: 'очередь решений диспетчера: алерты и уведомления' },
  { name: 'resolve_alert', description: 'применить выбранное решение по алерту' },
  {
    name: 'ai_resolve_alert',
    description: 'поручить разбор алерта платформенному AI (System one)',
  },
  { name: 'list_engineers', description: 'инженеры: навыки, транспорт, смена, доступность' },
  {
    name: 'set_engineer_availability',
    description: 'уволить инженера с линии или вернуть на линию',
  },
  {
    name: 'get_policies',
    description:
      'каталог политик и действующая. «Полное покрытие» поднимает покрытие первым критерием и может добавить резервные экипажи; оно не обещает назначить каждую заявку',
  },
  {
    name: 'select_policy',
    description: 'выбрать политику планирования. Перед этим: simulate_plan_change и review_action',
  },
  {
    name: 'get_router_controls',
    description: 'переключатели решателя: обеды, метро, пробки, оборудование',
  },
  {
    name: 'set_router_controls',
    description:
      'сменить один или несколько переключателей решателя. Сначала симуляция и review_action',
  },
  {
    name: 'set_control_mode',
    description:
      'manual замораживает автоплан, auto возвращает его решателю. Сначала review_action',
  },
  {
    name: 'simulate_plan_change',
    description:
      'проверка в симуляторе без записи в план: политика, каталог, переключатели, вызов инженера вне линии, окно, закрепление, снятие. В ответе числа до и после, включая инженеров и резервные экипажи covering',
  },
  {
    name: 'review_action',
    description:
      'самопроверка серьёзного действия: симуляция до/после и вердикт Разрешено или Риск. Если Риск — не применяй, пока диспетчер не примет вероятные риски',
  },
  {
    name: 'get_dispatcher_settings',
    description: 'оперативные настройки: часы дня, пороги алертов',
  },
  { name: 'update_dispatcher_settings', description: 'сменить оперативные настройки' },
  { name: 'start_workday', description: 'начать рабочий день (LIVE)' },
  {
    name: 'close_shift',
    description:
      'закрыть смену (пока есть неразобранные алерты — откажет). Перед закрытием вызови review_action',
  },
];

/** Renders the markdown file the dispatcher sends to their agent. */
export function renderMcpSetupMd(input: McpSetupInput): string {
  const url = `${input.origin.replace(/\/$/, '')}${input.endpoint}`;
  const tools = TOOL_CATALOGUE.map((tool) => `- \`${tool.name}\` — ${tool.description}`).join('\n');
  return `# LCT Smart Router — подключение агента к дашборду диспетчера

Этот файл выпустил диспетчер. Выполнив настройку, ты подключаешься к его дашборду по MCP
и можешь работать за него: смотреть обстановку, читать объяснения плана, разбирать алерты,
менять политики и настройки, вести рабочий день.

## Подключение

- **Транспорт:** MCP поверх HTTP (streamable HTTP, JSON-RPC 2.0). SSE-потоков нет,
  соединение stateless — сессия не требуется.
- **Endpoint:** \`${url}\`
- **Заголовок аутентификации (основной):**
  \`\`\`json
  { "X-MCP-Pin": "${input.pin}" }
  \`\`\`
- Если клиент умеет задавать только Bearer — подойдёт и он (пин выпущен как ключ диспетчера):
  \`\`\`json
  { "Authorization": "Bearer ${input.pin}" }
  \`\`\`

## Пример конфигурации

\`\`\`json
{
  "mcpServers": {
    "lct-dashboard": {
      "url": "${url}",
      "headers": { "X-MCP-Pin": "${input.pin}" }
    }
  }
}
\`\`\`

Для Claude Code то же самое одной командой:

\`\`\`bash
claude mcp add lct-dashboard --transport http ${url} --header "X-MCP-Pin: ${input.pin}"
\`\`\`

## Инструменты

${tools}

## Как работать

1. Начни с \`get_dispatcher_context\`, \`get_routing_principles\` и \`get_situation\`.
2. Все изменения — только через инструменты; каждый вызов идемпотентен и попадает в журнал операций.
3. Опирайся на факторы из \`get_plan_explanations\`, а не на собственные догадки о причинах.
4. Серьёзное действие сначала проверь. \`simulate_plan_change\` показывает, что станет с назначениями, опозданиями, пробегом и числом инженеров. \`review_action\` по тем же полям возвращает \`Разрешено\` или \`Риск\`. Если вердикт \`Риск\`, не применяй действие, пока диспетчер явно не примет вероятные риски.
5. Число инженеров бери только из текста симуляции. Дополнительный экипаж \`covering\` — резервный клон, не человек со смены. Политика «полное покрытие» не обещает закрыть каждую заявку.
6. Алерт нельзя «скрыть»: \`resolve_alert\` применяет решение из списка допустимых действий.
7. Сброс данных и перезапуск демо-дня через MCP недоступны — это подтверждаемые человеком действия.
8. Создание заявки с нуля остаётся формой дашборда. Условия уже существующей заявки смотри через \`get_request\`.

Пока ты работаешь, в шапке дашборда мигает робот — диспетчер это видит.
`;
}

/** Triggers a browser download of the setup file; safe to call from a click handler. */
export function downloadMcpSetupMd(input: McpSetupInput): void {
  const blob = new Blob([renderMcpSetupMd(input)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'setup.md';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
