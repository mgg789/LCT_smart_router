# RAGConnect — командная память для ИИ-агентов

Общая семантическая память команды LCT Smart Router и её ИИ-агентов (Codex, Cursor,
ZCode, Claude Desktop / Claude Code, любой MCP-совместимый клиент). Агенты используют
её, чтобы вспоминать проектные решения и сохранять важные находки между сессиями
и машинами.

| | |
|---|---|
| Адрес командной памяти | `https://testmem.droidje.com` (сервер MGG, nginx TLS → `127.0.0.1:8123`) |
| `project_label` | `lct` |
| Бэкенд | [RAGConnect](https://git.sverk.io/mgg789/ragconnect) (Client Gateway + Server Gateway + LightRAG) |
| LLM | OpenAI-совместимая: `https://ai.sverk.tech/v1`, модель `Gemma 4` (извлечение сущностей и обработка запросов) |
| Эмбеддинги | локальные `intfloat/multilingual-e5-small` (размерность 384), без внешнего API |
| Здоровье | `GET https://testmem.droidje.com/health` → `{"status":"ok","lightrag":"ok"}` |

Токены **не хранятся в этом репозитории** (AGENTS.md §13.4). Получите свой токен у Mike
(`mike-write` — для тимлида, общий `team-write` — для участников команды, `readonly-demo` —
для демо/жюри) и храните его в локальном `~/.ragconnect/client_config.yaml`.

---

## Быстрое подключение (~2 минуты)

Предпосылки: [Python](https://www.python.org/downloads/) ≥ 3.10 в PATH, git.

### 1. Склонируйте RAGConnect и установите клиентский шлюз

```bash
git clone https://git.sverk.io/mgg789/ragconnect.git
cd ragconnect

# Windows (Git Bash / PowerShell):
python -m venv "%USERPROFILE%\.ragconnect\.venv"
%USERPROFILE%\.ragconnect\.venv\Scripts\python -m pip install -e .

# macOS / Linux:
python3 -m venv ~/.ragconnect/.venv
~/.ragconnect/.venv/bin/python -m pip install -e .
```

Это ставит только лёгкий клиент (`mcp`, `httpx`, `pydantic`, `fastapi`) — без локального
LightRAG и без torch. Командная память работает только удалённо (remote-only).

### 2. Запишите свой конфиг клиента

Сохраните как `~/.ragconnect/client_config.yaml` (Windows: `C:\Users\<you>\.ragconnect\client_config.yaml`).
Замените `repo_root` на **свой** путь к репозиторию LCT и вставьте **свой** токен:

```yaml
# Командная память проекта LCT (remote-only: локальный LightRAG не нужен).
destinations:
  - label: lct
    display_name: LCT Smart Router (team memory)
    url: https://testmem.droidje.com
    token: tok_REPLACE_WITH_YOUR_TOKEN
    enabled: true

project_contexts:
  - repo_root: C:\path\to\LCT          # ваш локальный путь к этому репозиторию
    project_label: lct
    enabled: true

# Fallback, чтобы вызовы памяти без метки тоже попадали в командную память,
# пока вы работаете в этом репозитории. Удалите, если используете и другие проекты.
default_project: lct
remote_only_mode: true
strict_project_routing: true
```

Маршрутизация: явный `project_label="lct"` → командная память; корень воркспейса,
совпавший с `project_contexts` → командная память; иначе `default_project`. При
`remote_only_mode: true` локальной памяти нет, поэтому ничего не утекает в личные
пространства и из них.

### 3. Зарегистрируйте MCP-сервер в агенте

Запустите установщик из склонированного репозитория `ragconnect` (идемпотентно,
безопасно перезапускать):

| Агент | Windows | macOS / Linux |
|---|---|---|
| **ZCode** | `powershell -File scripts/windows/install-zcode-mcp.ps1` | `bash scripts/macos/install-zcode-mcp.sh` |
| **Codex** | `powershell -File scripts/windows/install-codex-mcp.ps1` | `bash scripts/macos/install-codex-mcp.sh` |
| **Cursor** | `powershell -File scripts/windows/install-cursor-mcp.ps1` | — (вручную, см. ниже) |
| **Claude Desktop** | `powershell -File scripts/windows/install-claude-mcp.ps1` | `bash scripts/macos/install-claude-mcp.sh` |
| Все сразу | `powershell -File scripts/windows/install-mcp.ps1` | `bash scripts/macos/install-mcp.sh` |

Затем **перезапустите агента**, чтобы он подхватил MCP-сервер.

Ручная настройка, если не хочется запускать скрипты, — точка входа всегда
`python -m client_gateway.mcp_server` из склонированного репозитория интерпретатором
из venv:

```jsonc
// Cursor / Claude Desktop: ~/.cursor/mcp.json или %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "ragconnect": {
      "command": "C:/Users/<you>/.ragconnect/.venv/Scripts/python.exe",
      "args": ["-m", "client_gateway.mcp_server"],
      "env": {
        "PYTHONPATH": "C:/path/to/ragconnect",
        "RAGCONNECT_CONFIG_PATH": "C:/Users/<you>/.ragconnect/client_config.yaml",
        "RAGCONNECT_PROMPTS_DIR": "C:/path/to/ragconnect/config/prompts",
        "RAGCONNECT_HTTP_TIMEOUT_SECONDS": "600",
        "MCP_TOOL_TIMEOUT": "600000",
        "PYTHONUTF8": "1"
      }
    }
  }
}
```

У ZCode иначе: серверы живут в `~/.zcode/cli/config.json` под **вложенным** ключом
`mcp.servers` (не `mcpServers`), и файл должен оставаться UTF-8 без BOM — скрипт
`install-zcode-mcp` обрабатывает и то и другое:

```json
{
  "mcp": {
    "servers": {
      "ragconnect": {
        "command": "C:/Users/<you>/.ragconnect/.venv/Scripts/python.exe",
        "args": ["-m", "client_gateway.mcp_server"],
        "env": { "...тот же env, что и выше..." }
      }
    }
  }
}
```

Codex использует TOML в `~/.codex/config.toml`:

```toml
[mcp_servers.ragconnect]
command = "C:/Users/<you>/.ragconnect/.venv/Scripts/python.exe"
args = ["-m", "client_gateway.mcp_server"]
enabled = true

[mcp_servers.ragconnect.env]
PYTHONPATH = "C:/path/to/ragconnect"
RAGCONNECT_CONFIG_PATH = "C:/Users/<you>/.ragconnect/client_config.yaml"
RAGCONNECT_PROMPTS_DIR = "C:/path/to/ragconnect/config/prompts"
RAGCONNECT_HTTP_TIMEOUT_SECONDS = "600"
```

### 4. Проверьте

Попросите агента вызвать `memory_search` с `query="What stack does LCT Smart Router use?"`
и `project_label="lct"` или проверьте вручную:

```bash
curl https://testmem.droidje.com/health
curl -X POST https://testmem.droidje.com/search \
  -H "Authorization: Bearer tok_YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "What stack does LCT Smart Router use?"}'
```

Ожидается: `"status":"ok"`, `"source":"project"` и ссылка на документ `mem-*.txt`.

---

## Правила памяти для агентов

Вставьте этот блок в проектный `AGENTS.md` / `CLAUDE.md` (или положитесь на MCP-промпт
`memory-context`, который шлюз вставляет автоматически):

```markdown
memory-label = "lct"

## Правила памяти RAGConnect

Этот проект использует RAGConnect как рабочую память команды; проектная память общая
для всех агентов команды. Пользуйтесь ею проактивно.

- Прежде чем отвечать на проектные вопросы, вызывайте `memory_search` с
  `project_label="lct"`.
- После решений, важных находок, первопричин багов и завершённых вех вызывайте
  `memory_write` с `project_label="lct"`.
- Память без метки (локальную) используйте только для личных или кросспроектных заметок.
- Никогда не записывайте секреты (токены, ключи, пароли) в проектную память.
```

MCP-инструменты, которые предоставляет шлюз: `memory_search`, `memory_write`,
`memory_ingest_bulk`, `memory_documents`, `memory_entities`, `memory_relations`,
`memory_graph`, `memory_health`, `memory_list_projects`, `memory_register_project`,
`memory_rebuild_index`, `memory_current_context`.

---

## Операции (тимлид)

Расположение на сервере: `/home/mgg/ragconnect-lct` на `mgg@178.140.207.217:2222` —
чекаут `main` из `git.sverk.io/mgg789/ragconnect` с `docker-compose.yml` (сервисы:
`lightrag`, `server-gateway`), `.env` (привязка LLM, пароль администратора,
`SERVER_GATEWAY_PORT=8123`), хранилище токенов в томе `server_data` по пути
`/data/server_tokens.yaml`. Маршрут nginx `testmem.droidje.com` → `127.0.0.1:8123`
(до 2026-09-16 он указывал на выведенный из эксплуатации стек KnMD на `:47804`; бэкап
старого конфига: `~/testmem.droidje.com.bak-20260916` на сервере).

```bash
# Деплой/обновление после продвижения main:
ssh -p 2222 mgg@178.140.207.217
cd /home/mgg/ragconnect-lct
git fetch origin main && git reset --hard origin/main
docker compose build server-gateway && docker compose up -d server-gateway

# Управление токенами (важно: --token-store должен указывать в том, иначе CLI
# пишет /app/server_tokens.yaml внутри контейнера, и шлюз его никогда не увидит):
docker compose exec -T server-gateway ragconnect-server token create \
  --role write --description "alice" --expires-days 180 \
  --token-store /data/server_tokens.yaml
docker compose exec -T server-gateway ragconnect-server token list \
  --token-store /data/server_tokens.yaml
docker compose exec -T server-gateway ragconnect-server token revoke tid_xxx \
  --token-store /data/server_tokens.yaml
```

Известные особенности:

- Записи ставятся в очередь: LightRAG сразу отвечает "received" и извлекает сущности
  в фоне (несколько секунд на `Gemma 4`). Поиск сразу после записи может ничего не
  возвращать, пока извлечение не завершится.
- Идентичный контент дедуплицируется (content-addressed `file_source`, HTTP 409 →
  наверху трактуется как успех); разный контент всегда создаёт новый документ памяти.
- LLM-эндпоинт используется только на сервере; эмбеддинги локальные, поэтому у стека
  памяти нет зависимости от OpenAI.

См. также: `docs/mcp-kanban.md` (MCP доски задач), `context/INDEX.md` (карта базы знаний).
