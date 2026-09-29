# Готовый docker-билд Navix 1.9

Собранные образы контура версии **1.9.0** (ветка `dev`, коммит `f07951a`,
дата сборки 29.09.2026). Пакет самодостаточен: вместе с образами проекта
включены PostgreSQL и OSRM-бэкенд, поэтому контур поднимается без сборки
и без загрузки чего-либо из внешних реестров.

Образы собраны для **linux/arm64** (Apple Silicon). На компьютере с x86
используйте традиционный запуск со сборкой:
`docker compose -f infra/docker-compose.yml up -d --build`.

## Что внутри

| Образ | Роль |
| --- | --- |
| `lct-smart-router-web` | Дашборд, приложение инженера и клиента (nginx) |
| `lct-smart-router-api` | System Layer: API, операции, объяснения, MCP |
| `lct-smart-router-migrate` | Однократная миграция схемы (тот же образ, что api) |
| `lct-smart-router-router` | Router Core (Python, OR-Tools, детерминированный сид) |
| `lct-smart-router-road-api` | Дорожный контур МКАД: геометрия плеч, `/route2` |
| `lct-smart-router-route-engine3` | Универсальный роутер v3: машина, пешком, метро |
| `lct-smart-router-sys1` | System one (Jev): decision API для AI-функций |
| `pgvector/pgvector:pg17` | PostgreSQL 17 (внешний образ, включён в пакет) |
| `ghcr.io/project-osrm/osrm-backend` | OSRM-бэкенд (внешний образ, включён в пакет) |

Имена образов совпадают с теми, что Compose даёт при локальной сборке, поэтому
после загрузки Compose использует готовые образы и не запускает сборку.

## Как развернуть

Из корня репозитория:

```bash
cat builds/v1.9/navix-v1.9-images.tar.gz.part-* | docker load
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
```

- Проверка целостности перед загрузкой: `cat builds/v1.9/navix-v1.9-images.tar.gz.part-* | shasum -a 256`
  — сумма должна совпасть с `navix-v1.9-images.tar.gz.sha256`; контрольные суммы
  частей — в `SHA256SUMS`.
- Файл окружения обязателен (`env_file` в Compose): `.env.example` не содержит
  секретов, почту и пароль диспетчера задайте сами или подставьте файл окружения
  с Google Drive из сдачи.
- При `DEMO_STAND=true` (по умолчанию в `.env.example`) контур сам поднимает
  демонстрационный день.

| Сервис | Адрес |
| --- | --- |
| Дашборд | <http://127.0.0.1:5173> |
| API (Swagger) | <http://127.0.0.1:8000/docs> |
| Router Core | <http://127.0.0.1:8100> |

## Состав пакета

Части `navix-v1.9-images.tar.gz.part-*` — это один gzip-архив `docker save`
(889 МБ), разрезанный на куски по 95 МиБ, чтобы уложиться в лимит размера
объекта git-хостинга. Восстановление — `cat` всех частей подряд, как выше;
раскладывать по отдельности их не нужно.

Версия пакета зафиксирована в `launch/release.json` (`1.9.0`, канал
`release`); манифест целостности исходников — `launch/manifest.json`.
Профили Compose `observability` (Prometheus, OTel) и `redis-beta` в пакет
не входят — при необходимости они скачиваются при запуске профиля.
