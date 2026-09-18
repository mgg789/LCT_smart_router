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
| `cd` | push в `main` (после мержа) | те же проверки, затем compose + SMTP deploy, затем health сервисов |

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
и в пайплайн не входит: импорт синтетического сектора → снимок → расчёт ядром →
приёмка → срочная заявка → вторая приёмка. Полные `pnpm --filter api test` тоже
нужна живая PostgreSQL (тот же compose).

## Deploy

`cd` по SSH заходит на два хоста одним push в `main`:

1. MGG — тот же compose-путь, что и скилл `mgg-server-deploy`: fast-forward
   `main` в `/home/mgg/navix`, затем

```bash
docker compose -f docker-compose.yml up -d --build --remove-orphans
```

2. SMTP — `scripts/ci/ssh-deploy-smtp.sh` заливает `infra/smtp/` во
   временный `/tmp/navix-smtp.*` на `deploy@194.87.202.172` и вызывает
   идемпотентный apply. Распаковка не в `/home/deploy/smtp`: тот каталог
   после первого ручного apply часто принадлежит root, и повторный `tar`
   падает с `File exists`. Полный clone монорепы на почтовом хосте не нужен.
   Если раннер SourceCraft не достучится до `:22` SMTP-хоста, деплой идёт
   прыжком `SourceCraft → MGG:2222 → SMTP:22`.

Корневой [docker-compose.yml](../docker-compose.yml) включает
`infra/docker-compose.yml`, чтобы скилл находил контур, не зная про `infra/`.

Хелсчеки сразу после `up` (внутри `deploy` / `deploy-smtp`):

- публичный гейт `https://navix.droidje.com/`
- loopback `http://127.0.0.1:18080/health/live` (этот хост уже публикует другое
  приложение на `:8000`; System Layer остаётся в сети compose на `api:8000`,
  изменился только хостовый порт публикации)
- watchdog SMTP `http://127.0.0.1:8587/health` на почтовом хосте

После обоих деплоев отдельная задача `health` ждёт 20 с и ещё раз проверяет
публичный гейт плюс loopback `/health/live`, `/health/ready` и `/health/services`.
Пайплайн красный, если `database`, `router` или `smtp` не `ok`. `ai` по-прежнему
`not_configured` и в гейт не входит. Скрипты:
`scripts/ci/ssh-check-health.sh`, `scripts/ci/check-deploy-health.sh`,
`scripts/ci/evaluate_health_services.py`.

Дашборд — контейнер `web` на `127.0.0.1:5173`; хостовый nginx терминирует TLS для
`navix.droidje.com` и проксирует туда. `web` уже проксирует `/api/` на `api:8000`.
На этом хосте `.env` обязан переносить занятые порты:

- `API_PORT=127.0.0.1:18080` — хостовый `:8000` занят;
- `ROUTER_PORT=18100` — хостовый `127.0.0.1:8100` занят (`binom-landing-test`).

Внутри сети compose по-прежнему `api:8000` и `router:8100`. Это остаётся
демо-контур: `NODE_ENV=development` и `AUTH_DEV_EXPOSE_CODES=true` — приложение
отказывается сочетать открытые коды входа с `production`.

### Секреты и разовые настройки хоста

Создайте в SourceCraft секреты репозитория:

- **`MGG_DEPLOY_SSH_KEY`** — приватная половина deploy-only SSH-ключа, публичная
  половина которого лежит в `mgg@178.140.207.217` → `~/.ssh/authorized_keys`.
- **`SMTP_DEPLOY_SSH_KEY`** — отдельный deploy-only ключ
  (`~/.ssh/navix_smtp_ci` на машине, которая его создала). Публичная половина
  уже в `deploy@194.87.202.172` → `~/.ssh/authorized_keys`. Не используйте
  личный ключ ноутбука и не пароль root.

Ключи не коммитить, на доску не класть, в командную память не писать.

Поле Value в UI SourceCraft часто схлопывает переносы строк. Тогда CD пишет
`Load key … error in libcrypto` и дальше `Permission denied` — это не пароль
сервера, а битый PEM. Нужен **весь** файл `~/.ssh/navix_mgg_ci`, с строками
`BEGIN` / `END`. Если секрет уже лежит одной строкой, перезапишите его
(API ждёт base64 содержимого файла) или вставьте файл целиком ещё раз.
`scripts/ci/ssh-deploy.sh` умеет восстановить PEM из `\n` / base64 / одной
строки, но корректный секрет надёжнее.

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
