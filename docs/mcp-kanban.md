# Канбан-доска задач: kan.bn MCP (task.droidje.com)

> Основная доска задач проекта — **kan.bn** по адресу https://task.droidje.com (воркспейс **LCT**, slug `droidje`). Все агенты (Codex, Cursor, ZCode) и участники команды работают с задачами через MCP-сервер `kan`. Эта инструкция — как подключить и пользоваться.

---

## 1. Как устроено

- Канбан: **[kan.bn](https://github.com/kanbn/kan)** (self-hosted на MGG-сервере, контейнер `kan-web`, порт 8101 → nginx → task.droidje.com).
- MCP-сервер: официальный пакет kan `@kan/mcp` (`packages/mcp` в репозитории kan) — stdio-сервер, который ходит в REST API доски (`{KAN_BASE_URL}/api/v1`) с Bearer-токеном.
- Собранный бандл (esbuild от src/index.ts, зависимости вшиты; запускается `node`):
  - Mac (Mike): **`~/.mcp-servers/kan-mcp/kan-mcp.mjs`**;
  - Windows (Данила): `C:\Users\user\.mcp-servers\kan-mcp\kan-mcp.mjs`.

Инструменты MCP (7 групп): `list_workspaces`/`find_workspace_by_name`/`get_workspace*`, board-инструменты (создание/чтение/перемещение досок), `list_*`, card-инструменты (создание, обновление, перемещение, комментарии), checklist-инструменты, label-инструменты, member-инструменты. Полный список: `tools/list` через любой клиент.

## 2. Аутентификация

- `KAN_API_TOKEN` — персональный API-ключ пользователя better-auth (плагин `apiKey`, ключ хранится в БД доски хешированным). Формат — 64 случайных латинских буквы, опционально с префиксом `kan_` (итого до 68 символов); короче 64 better-auth отклоняет.
- Текущий ключ создан для аккаунта владельца (Mike / dumpgino@gmail.com), имя ключа в UI: `mcp-agents`.
- **Важно:** ключ даёт полный доступ к доскам владельца — не коммитить его в публичные репозитории, в конфигах агентов он лежит в локальных файлах (`~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.zcode/cli/config.json`).

### Как создать свой ключ (если нужно)

1. Через UI доски: Settings → API Keys → Create (плагин better-auth apiKey включён).
2. Программно (для админа сервера): ключ = 64 случайных латинских буквы; в таблицу `apiKey` БД `kan_db` вставляется строка: `key` = SHA-256 ключа в base64url **без паддинга**, `start` = первые 6 символов ключа, `userId` = id пользователя, `enabled` = true, `rateLimitEnabled` = true, `rateLimitTimeWindow` = 60000, `rateLimitMax` = 600, `remaining` = 600. Валидация better-auth отклоняет ключи короче 64 символов (ошибка `FORBIDDEN Invalid API key`) — следите за длиной.

## 3. Подключение к агентам (текущая машина, уже сделано)

| Агент | Файл конфига | Секция |
|---|---|---|
| **ZCode** | `~/.zcode/cli/config.json` | `mcp.servers.kan` |
| **Cursor** | `~/.cursor/mcp.json` | `mcpServers.kan` |
| **Codex** | `~/.codex/config.toml` | `[mcp_servers.kan]` |

Конфиг у всех трёх одинаковый по смыслу (путь к бандлу — под свою машину):

```json
{
  "command": "node",
  "args": ["~/.mcp-servers/kan-mcp/kan-mcp.mjs"],
  "env": {
    "KAN_BASE_URL": "https://task.droidje.com",
    "KAN_API_TOKEN": "<API-ключ>"
  }
}
```

На Mac (Mike) в `command` указан абсолютный путь до node через шим mise — `/Users/mike/.local/share/mise/shims/node`: GUI-приложения (Cursor, ZCode) не видят PATH mise, голый `node` там не резолвится. В JSON-конфигах тильду не раскрывает никто — пишите полные пути.

Codex (TOML):

```toml
[mcp_servers.kan]
command = "node"
args = ["~/.mcp-servers/kan-mcp/kan-mcp.mjs"]
env = { KAN_BASE_URL = "https://task.droidje.com", KAN_API_TOKEN = "<API-ключ>" }
```

После правки конфига перезапустить сессию агента (MCP подключается на старте). В ZCode статус сервера: Settings → MCP.

## 4. Подключение на другой машине (для нового агента/участника)

1. Получить API-ключ: попросить владельца создать ключ (`mcp-<agent>`) или зайти в UI доски своим аккаунтом → Settings → API Keys.
2. Положить бандл: скопировать папку `C:\Users\user\.mcp-servers\kan-mcp\` (или собрать заново — п.5).
3. Вставить конфиг (п.3) в файл своего агента с путями под свою машину.
4. Проверка руками (bash):

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | KAN_BASE_URL=https://task.droidje.com KAN_API_TOKEN=<ключ> node kan-mcp.mjs | head -c 800
```

Ответ `serverInfo: {"name":"kan"}` + список инструментов = всё работает.

## 5. Пересборка бандла (если kan обновился и MCP-пакет изменился)

Вариант A — из публичного репозитория (без SSH к серверу; так собран бандл на Mac 2026-09-18). Зависимости ставятся в отдельную папку, src туда не копируется — esbuild собирает прямо из клона (копирование src через `cp` в сессиях ZCode блокирует хук Mimosa):

```bash
git clone --depth 1 https://github.com/kanbn/kan /tmp/kan-src
mkdir -p ~/.mcp-servers/kan-mcp && cd ~/.mcp-servers/kan-mcp
npm init -y && npm pkg set type=module
npm i @modelcontextprotocol/sdk zod esbuild
ln -sfn ~/.mcp-servers/kan-mcp/node_modules /tmp/kan-src/packages/mcp/node_modules
./node_modules/.bin/esbuild /tmp/kan-src/packages/mcp/src/index.ts \
  --bundle --format=esm --platform=node --outfile="$HOME/.mcp-servers/kan-mcp/kan-mcp.mjs"
```

Вариант B — с сервера (если серверная версия опережает GitHub):

```bash
mkdir -p ~/.mcp-servers/kan-mcp
scp -P 2222 -r mgg@178.140.207.217:/home/mgg/kan/packages/mcp/src ~/.mcp-servers/kan-mcp/src
cd ~/.mcp-servers/kan-mcp
npm init -y && npm pkg set type=module
npm i @modelcontextprotocol/sdk zod esbuild
npx esbuild src/index.ts --bundle --format=esm --platform=node --outfile=kan-mcp.mjs
```

## 6. Рабочие соглашения по задачам (для агентов)

- Воркспейс: **LCT** (публичный id `1kh73hl7xn3i`, slug `droidje`). Сначала `list_workspaces`/`get_workspace_by_slug`, дальше — по publicId.
- Доска проекта — основная канва статуса: задачи держим актуальными (взял в работу → двигай карточку; готов → закрой), комментарии с кратким итогом работы.
- Тексты задач пишем так, чтобы другому агенту был понятен контекст без чтения этой переписки: что сделать, критерий готовности, ссылки на файлы/PR.
- Лимит запросов API-ключа: 600/мин (better-auth rate limit) — агенты этот лимит не исчерпают.

## 7. Где что живёт на сервере (для админа)

- Приложение: `/home/mgg/kan` (compose: `kan-web`, `kan-db`, миграции), дамп/логи — стандартно через docker.
- Доступ: `ssh -p 2222 mgg@178.140.207.217` (скил `mgg-server-deploy`, скопирован в `~/.zcode/skills/` и `~/.cursor/skills/`).
- Токены в конфигах агентов локальные; `KAN_ADMIN_API_KEY` сервера — админ-ключ приложения, для MCP не используется.
