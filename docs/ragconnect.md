# RAGConnect — Team Memory for AI Agents

Shared semantic memory for the LCT Smart Router team and its AI agents (Codex, Cursor,
ZCode, Claude Desktop / Claude Code, any MCP-compatible client). Agents use it to recall
project decisions and to persist important findings across sessions and machines.

| | |
|---|---|
| Team memory endpoint | `https://testmem.droidje.com` (MGG server, nginx TLS → `127.0.0.1:8123`) |
| `project_label` | `lct` |
| Backend | [RAGConnect](https://git.sverk.io/mgg789/ragconnect) (Client Gateway + Server Gateway + LightRAG) |
| LLM binding | OpenAI-compatible: `https://ai.sverk.tech/v1`, model `Gemma 4` (entity extraction & query processing) |
| Embeddings | local `intfloat/multilingual-e5-small` (dim 384), no external API |
| Health | `GET https://testmem.droidje.com/health` → `{"status":"ok","lightrag":"ok"}` |

Tokens are **not stored in this repository** (AGENTS.md §13.4). Get your token from Mike
(`mike-write` for the team lead, `team-write` shared token for teammates, `readonly-demo`
for demo/judges) and keep it in your local `~/.ragconnect/client_config.yaml`.

---

## Quick connect (~2 minutes)

Prerequisites: [Python](https://www.python.org/downloads/) ≥ 3.10 on PATH, git.

### 1. Clone RAGConnect and install the client gateway

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

This installs only the light client (`mcp`, `httpx`, `pydantic`, `fastapi`) — no local
LightRAG, no torch. Team memory is remote-only.

### 2. Write your client config

Save as `~/.ragconnect/client_config.yaml` (Windows: `C:\Users\<you>\.ragconnect\client_config.yaml`).
Replace the `repo_root` with **your** path to the LCT repo and paste **your** token:

```yaml
# Team memory for the LCT project (remote-only: no local LightRAG needed).
destinations:
  - label: lct
    display_name: LCT Smart Router (team memory)
    url: https://testmem.droidje.com
    token: tok_REPLACE_WITH_YOUR_TOKEN
    enabled: true

project_contexts:
  - repo_root: C:\path\to\LCT          # your local path to this repo
    project_label: lct
    enabled: true

# Fallback so label-less memory calls still land in the team memory
# while working in this repo. Remove if you also use other projects.
default_project: lct
remote_only_mode: true
strict_project_routing: true
```

Routing: explicit `project_label="lct"` → team memory; workspace root matching
`project_contexts` → team memory; otherwise `default_project`. With `remote_only_mode: true`
there is no local memory, so nothing leaks to or from personal spaces.

### 3. Register the MCP server in your agent

Run the installer from the cloned `ragconnect` repo (idempotent, safe to re-run):

| Agent | Windows | macOS / Linux |
|---|---|---|
| **ZCode** | `powershell -File scripts/windows/install-zcode-mcp.ps1` | `bash scripts/macos/install-zcode-mcp.sh` |
| **Codex** | `powershell -File scripts/windows/install-codex-mcp.ps1` | `bash scripts/macos/install-codex-mcp.sh` |
| **Cursor** | `powershell -File scripts/windows/install-cursor-mcp.ps1` | — (manual, see below) |
| **Claude Desktop** | `powershell -File scripts/windows/install-claude-mcp.ps1` | `bash scripts/macos/install-claude-mcp.sh` |
| All of them | `powershell -File scripts/windows/install-mcp.ps1` | `bash scripts/macos/install-mcp.sh` |

Then **restart the agent** so it picks up the MCP server.

Manual config, if you prefer not to run scripts — the entrypoint is always
`python -m client_gateway.mcp_server` from the cloned repo with the venv interpreter:

```jsonc
// Cursor / Claude Desktop: ~/.cursor/mcp.json or %APPDATA%\Claude\claude_desktop_config.json
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

ZCode differs: servers live in `~/.zcode/cli/config.json` under a **nested** `mcp.servers`
key (not `mcpServers`), and the file must stay BOM-less UTF-8 — the `install-zcode-mcp`
script handles both:

```json
{
  "mcp": {
    "servers": {
      "ragconnect": {
        "command": "C:/Users/<you>/.ragconnect/.venv/Scripts/python.exe",
        "args": ["-m", "client_gateway.mcp_server"],
        "env": { "...same env as above..." }
      }
    }
  }
}
```

Codex uses TOML in `~/.codex/config.toml`:

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

### 4. Verify

Ask your agent to call `memory_search` with `query="What stack does LCT Smart Router use?"`
and `project_label="lct"`, or check manually:

```bash
curl https://testmem.droidje.com/health
curl -X POST https://testmem.droidje.com/search \
  -H "Authorization: Bearer tok_YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "What stack does LCT Smart Router use?"}'
```

Expected: `"status":"ok"`, `"source":"project"` and a reference to a `mem-*.txt` document.

---

## Memory rules for agents

Paste this block into your project `AGENTS.md` / `CLAUDE.md` (or rely on the MCP prompt
`memory-context`, which the gateway injects automatically):

```markdown
memory-label = "lct"

## RAGConnect memory rules

This project uses RAGConnect as the team's working memory; project memory is shared by
all agents of the team. Use it proactively.

- Before answering project questions, call `memory_search` with `project_label="lct"`.
- After decisions, important findings, bug root causes and completed milestones, call
  `memory_write` with `project_label="lct"`.
- Use no-label (local) memory only for personal or cross-project notes.
- Never write secrets (tokens, keys, passwords) into project memory.
```

MCP tools exposed by the gateway: `memory_search`, `memory_write`, `memory_ingest_bulk`,
`memory_documents`, `memory_entities`, `memory_relations`, `memory_graph`,
`memory_health`, `memory_list_projects`, `memory_register_project`,
`memory_rebuild_index`, `memory_current_context`.

---

## Operations (team lead)

Server layout: `/home/mgg/ragconnect-lct` on `mgg@178.140.207.217:2222` — a checkout of
`git.sverk.io/mgg789/ragconnect` `main` with `docker-compose.yml` (services: `lightrag`,
`server-gateway`), `.env` (LLM binding, admin password, `SERVER_GATEWAY_PORT=8123`),
token store in the `server_data` volume at `/data/server_tokens.yaml`.
nginx route `testmem.droidje.com` → `127.0.0.1:8123` (before 2026-09-16 it pointed at the
retired KnMD stack on `:47804`; backup of the old config:
`~/testmem.droidje.com.bak-20260916` on the server).

```bash
# Deploy / update after main moves upstream:
ssh -p 2222 mgg@178.140.207.217
cd /home/mgg/ragconnect-lct
git fetch origin main && git reset --hard origin/main
docker compose build server-gateway && docker compose up -d server-gateway

# Token management (note: --token-store must point into the volume, otherwise the
# CLI writes /app/server_tokens.yaml inside the container and the gateway never sees it):
docker compose exec -T server-gateway ragconnect-server token create \
  --role write --description "alice" --expires-days 180 \
  --token-store /data/server_tokens.yaml
docker compose exec -T server-gateway ragconnect-server token list \
  --token-store /data/server_tokens.yaml
docker compose exec -T server-gateway ragconnect-server token revoke tid_xxx \
  --token-store /data/server_tokens.yaml
```

Known caveats:

- Writes are queued: LightRAG replies "received" immediately and extracts entities in the
  background (a few seconds on `Gemma 4`). Search right after a write may return nothing
  until extraction finishes.
- Identical content is deduplicated (content-addressed `file_source`, HTTP 409 → treated
  as success upstream); different content always creates a new memory document.
- The LLM endpoint is only used server-side; embeddings are local, so the memory stack
  has no OpenAI dependency.

Related: `docs/mcp-kanban.md` (task board MCP), `context/INDEX.md` (knowledge base map).
