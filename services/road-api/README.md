# Road API — MKAD roads for route geometry and travel times

Точечный дорожный роутинг по графу МКАД (OSRM MLD): то, что превращает
пунктирные хорды на карте в линии по улицам. Сервис вендорен в репозиторий
и деплоится всегда вместе с контуром (`infra/docker-compose.yml`):
`osrm` (граф) + `road-api` (HTTP). System Layer обращается к `road-api`
по `ROUTER_ROAD_API_URL` (в compose по умолчанию `http://road-api:8123`).

## Состав

- `server.py` — HTTP (stdlib-only): `/route`, `/route2` (дорога даже для
  точек чуть за кольцом + v2-модель пробок), `/matrix2` (пакетная матрица),
  `/health`, `/model`, демо-UI `/` и `/v2`. Кольцо МКАД — `data/mkad-exact.geojson`.
- `traffic.py` — детерминированная модель пробок `moscow-radial-v1` с
  демо-расширением (МКАД/ТТК/Садовое в час пик ×2.6, магистрали ×1.8).
- `osrm/` — готовый граф `moscow-mkad` (вырезка OSM внутри буфера МКАД,
  167 МБ): `osrm-routed --algorithm mld`.
- `data/` — кольцо МКАД для классификации точек.

Источник и пайплайн пересборки графа: проект
`~/Projects/LCT/moscow-road-graph` (`scripts/pipeline.sh`: mkad → extract →
graph → serve; тяжёлая обработка OSM — pyosmium на хосте).

## Локально

```bash
docker compose up -d osrm road-api
curl 'http://127.0.0.1:8123/route2?a=55.7520,37.6175&b=55.7600,37.6300'
```

`/health` отвечает `{"osrm": true}`, когда граф прогрет. После старта
первые запросы могут быть медленными (прогрев страниц графа) — healthcheck
это учитывает.
