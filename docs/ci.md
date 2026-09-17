# CI/CD — SourceCraft и публичный гейт

> Живые заметки по пайплайну. Сам контур описан в
> [runbook.md](./runbook.md) и [architecture.md](./architecture.md).

SourceCraft читает [`.sourcecraft/ci.yaml`](../.sourcecraft/ci.yaml) из **дефолтной
ветки** репозитория (`main`). Пока этого файла нет на `main`, триггеры на push и
pull request не запускаются.

## Воркфлоу

| Воркфлоу | Когда | Что |
|---|---|---|
| `ci` | push в `dev`; pull request в `dev` или `main` | lint, тесты, скан секретов, mojibake |
| `cd` | push в `main` (после мержа) | те же проверки, затем compose build + deploy |

Красный прогон `ci` на pull request в `main` — условие мержа. Защита веток в
[`.sourcecraft/branches.yaml`](../.sourcecraft/branches.yaml) блокирует прямой push
и force-push в `main`, а также force-push/удаление `dev`.

### Задачи `ci`

- **lint** — `pnpm lint` (Biome) и `ruff check core`.
- **test-js** — Vitest веба + typecheck; `node:test` API против одноразового
  контейнера `pgvector/pgvector:pg17` (`scripts/ci/run-js-tests.sh`).
- **test-core** — `pytest core/tests`. Golden-бенчмарки официальных регионов
  **не** входят в эту задачу (слишком тяжело на каждый push).
- **secrets** — `gitleaks detect` с [`.gitleaks.toml`](../.gitleaks.toml).
- **mojibake** — `node scripts/ci/check-mojibake.mjs` (UTF-8 / cp1251-как-UTF-8).

`pnpm smoke` остаётся гейтом локального/демо-контура (AGENTS.md §11.1). Он деструктивен
и в пайплайн не входит.

## Deploy

`cd` по SSH заходит на хост MGG с тем же compose-путём, что и скилл
`mgg-server-deploy`: fast-forward `main` в `/home/mgg/navix`, затем

```bash
docker compose -f docker-compose.yml up -d --build --remove-orphans
```

Корневой [docker-compose.yml](../docker-compose.yml) включает
`infra/docker-compose.yml`, чтобы скилл находил контур, не зная про `infra/`.

Хелсчеки после `up`:

- публичный гейт `https://navix.droidje.com/`
- loopback `http://127.0.0.1:18080/health/live` (этот хост уже публикует другое
  приложение на `:8000`; System Layer остаётся в сети compose на `api:8000`,
  изменился только хостовый порт публикации)

Дашборд — контейнер `web` на `127.0.0.1:5173`; хостовый nginx терминирует TLS для
`navix.droidje.com` и проксирует туда. `web` уже проксирует `/api/` на `api:8000`.
На этом хосте `.env` обязан переносить занятые порты:

- `API_PORT=127.0.0.1:18080` — хостовый `:8000` занят;
- `ROUTER_PORT=18100` — хостовый `127.0.0.1:8100` занят (`binom-landing-test`).

Внутри сети compose по-прежнему `api:8000` и `router:8100`. Это остаётся
демо-контур: `NODE_ENV=development` и `AUTH_DEV_EXPOSE_CODES=true` — приложение
отказывается сочетать открытые коды входа с `production`.

### Секреты и разовые настройки хоста

Создайте в SourceCraft секрет репозитория с именем **`MGG_DEPLOY_SSH_KEY`**: приватная
половина deploy-only SSH-ключа, публичная половина которого лежит в
`mgg@178.140.207.217` → `~/.ssh/authorized_keys`. Ключ не коммитить, на доску не
класть, в командную память не писать.

Хосту MGG нужен также **read-only deploy-ключ SourceCraft**, чтобы
`git pull --ff-only origin main` работал в `/home/mgg/navix`. Публичную половину —
в Deploy keys репозитория; приватная остаётся в `~mgg/.ssh/navix_sourcecraft`
(см. `~mgg/.ssh/config`).

`scripts/ci/bootstrap-navix-host.sh` создаёт pull-ключ SourceCraft и серверный
`.env` (случайные пароли БД и диспетчера, loopback API на `18080`, публикация
router на `18100`). Учётные данные диспетчера живут только в
`/home/mgg/navix/.env`.

Хостовый nginx CI не пишет. После появления клона, на сервере:

```bash
sudo bash /home/mgg/navix/scripts/ci/install-navix-nginx.sh
```

Это ставит [infra/nginx/navix.droidje.com.conf](../infra/nginx/navix.droidje.com.conf)
(`proxy_pass http://127.0.0.1:5173`) и запрашивает сертификат через certbot. `mgg`
в группе `sudo`, но пароль интерактивный.

Секрет монтируется только в задаче `cd` / `deploy` (push в `main`) и никогда —
в пайплайнах pull request.

Ручной деплой с машины, у которой уже есть SSH к хосту:

```powershell
& "$env:USERPROFILE\.cursor\skills\mgg-server-deploy\scripts\deploy-mgg-app.ps1" `
  -AppDir "/home/mgg/navix" `
  -BranchOrRef "main" `
  -HealthcheckUrl "https://navix.droidje.com/"
```

## Порядок активации

1. Вмержить `feat/infra-sourcecraft-ci` в `dev`.
2. Разложить deploy-ключ на сервер и приватную половину в SourceCraft **до** первого
   мержа в `main`.
3. Мерж тимлида `dev` → `main`. Этот коммит активирует триггеры и должен запустить `cd`.
