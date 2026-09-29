# route-engine3

Автономный HTTP-сервис дорожных и пешеходных маршрутов: OSRM-графы из папки,
три эндпойнта (`/route3`, `/matrix3`, `/metro3`), модель трафика v2 для авто,
составные пешеходные маршруты с метро. Никаких зависимостей от кода LCT Smart
Router — поднимается в любом проекте одной командой.

**Лицензия: Apache License 2.0** ([LICENSE](./LICENSE)) — движок можно
использовать и в коммерческих проектах. Остальной репозиторий LCT Smart Router
распространяется по PolyForm Noncommercial 1.0.0 (см. корневой [LICENSE](../../LICENSE));
эта папка — единственное исключение.

## Быстрый старт

```bash
docker build -t route-engine3 services/route-engine3

docker run -d --name route-engine3 -p 8124:8124 \
  --tmpfs /graph-pages:size=1024m \
  -v /путь/к/graphs:/srv/graphs:ro \
  -e ENGINE3_GRAPHS_DIR=/srv/graphs \
  -e ENGINE3_PAGE_DIR=/graph-pages \
  route-engine3
```

Проверка готовности: `curl http://localhost:8124/health` → `{"ready": true}`.

```bash
# авто-маршрут с моделью трафика на время выезда
curl "http://localhost:8124/route3?a=55.79,37.54&b=55.80,37.53&profile=car&traffic=1&departure=1788000000"

# матрица времён 25×25 по графу
curl "http://localhost:8124/matrix3?points=55.79,37.54;55.80,37.53;...&profile=car"

# пеший маршрут с метро (нужен METRO_DATA_PATH)
curl "http://localhost:8124/route3?a=...&b=...&profile=walk&metro=1"
```

## Документация

- **[docs/route3.md](../../docs/route3.md)** — полное интеграционное описание:
  формат папки графов (`graphs/car/`, `graphs/foot/` + `graph.json`),
  переменные окружения (`ENGINE3_PORT`, `ENGINE3_GRAPHS_DIR`, `ENGINE3_PAGE_DIR`,
  `ENGINE3_OSRM_*`, `METRO_DATA_PATH`), контракты `/route3` `/matrix3` `/metro3`
  `/graphs` `/model` `/health` с примерами ответов, режимы `road` / `straight` /
  `metro_composite`, интеграция с Router Core и осознанные ограничения.
- **[traffic.py](./traffic.py)** — модель трафика v2 (car-only): радиальные
  полосы суток с учётом направления «к центру / из центра / поперёк», классы
  дорог (МКАД+ТТК+Садовое ×2.6 и магистрали ×1.8 в узкие окна пиков, улицы
  ×1.2), центральный бонус, длина-зависимая скорость прямых коннекторов.
  Пешеход и велосипед трафик не получают никогда (плоская скорость по
  `graph.json`).

## Что считает каждый профиль

| Профиль | Граф | Трафик | Метро |
|---|---|---|---|
| `car` | автомобильный (МКАД-контур) | да, на время выезда (`traffic=1`) | — |
| `walk` | пешеходный (footway/pedestrian/steps/sidewalk) | никогда | да, композит при `metro=1` |
| `bike` | пешеходный | никогда | — |
| `transit` | пешеходный | никогда | да |

За пределами покрытия графа — режим `straight`: хорда с disclosed-скоростью,
в ответе помечена `mode=straight`.

## Сторонний код

Lua-профили в `graph-tools/profiles/` (включая `lib/`) вендорены из
[project-osrm/osrm-backend](https://github.com/project-osrm/osrm-backend)
и остаются под их лицензией (BSD 2-clause) — SPDX на них не проставляется.
Собственные файлы движка (`server.py`, `graphs.py`, `metro.py`, `traffic.py`,
`graph-tools/build_foot_graph.sh`, `graph-tools/cut_mkad_foot_graph.py`,
`Dockerfile`) помечены `SPDX-License-Identifier: Apache-2.0`.
