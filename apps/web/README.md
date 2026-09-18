# Dashboard (`apps/web`)

Диспетчерский день: список инженеров, карта MapLibre, таймлайн, объяснения
«Факты → влияние → результат», сравнение политик, загрузка датасета ТЗ.

Живые данные идут через `src/api/client.ts` на System Layer (`/api` → api:8000).
`src/fixtures/dev-day.ts` — только тестовый снимок для vitest, не источник экрана.

```bash
pnpm --filter web dev      # http://127.0.0.1:5173, прокси `/api` на 8000
pnpm --filter web test
pnpm --filter web build
```

В docker-compose сервис `web` отдаёт production-сборку на <http://127.0.0.1:5173>.
Семь шагов ТЗ: [docs/tz-acceptance.md](../../docs/tz-acceptance.md).
Контракт фронт ↔ бэк: [docs/frontend-api.md](../../docs/frontend-api.md).
V0.1: [docs/release-v0.1.md](../../docs/release-v0.1.md).
