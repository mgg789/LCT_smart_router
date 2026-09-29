# Dashboard (`apps/web`)

Три ролевых интерфейса в одной Vite-сборке: дашборд диспетчера (`/`),
приложение инженера (`/engineer/`) и приложение клиента (`/client/`).
Дашборд показывает инженеров, карту MapLibre, таймлайн, причины назначения,
сравнение политик и загрузку датасета ТЗ.

Живые данные идут через `src/api/client.ts` на System Layer (`/api` → api:8000).
`src/fixtures/dev-day.ts` — только тестовый снимок для vitest, не источник экрана.

```bash
pnpm --filter web dev      # http://127.0.0.1:5173, прокси `/api` на 8000
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter web build
```

В docker-compose сервис `web` отдаёт production-сборку на <http://127.0.0.1:5173>.
Семь шагов ТЗ: [docs/tz-acceptance.md](../../docs/tz-acceptance.md).
Контракт фронт ↔ бэк: [docs/frontend-api.md](../../docs/frontend-api.md).
V0.1: [docs/release-v0.1.md](../../docs/release-v0.1.md).

Рабочие состояния, AI, чаты, мобильные приложения и границы проверки —
[docs/web.md](../../docs/web.md); запуск бэкенда — [runbook](../../docs/runbook.md).
Команды выполняются из корня после `pnpm install --frozen-lockfile`.
Dev-сборка требует доступный System Layer; фикстуры не подменяют недоступный API.
