# Road API — MKAD roads for route geometry and travel times

Точечный дорожный роутинг по графу МКАД (OSRM MLD): то, что превращает
пунктирные хорды на карте в линии по улицам. Сервис вендорен в репозиторий
и деплоится всегда вместе с контуром (`infra/docker-compose.yml`):
`osrm` (граф) + `road-api` (HTTP). System Layer получает геометрию по
`API_ROAD_API_URL`, Router получает стоимости по `ROUTER_ROAD_API_URL`
(оба compose-default: `http://road-api:8123`).

## Состав

- `server.py` — HTTP (stdlib-only): `/route`, `/route2` (дорога даже для
  точек чуть за кольцом при привязке не дальше 250 м; иначе прямая +
  v2-модель пробок), `/matrix2` (пакетная матрица),
  `/health`, `/model`, демо-UI `/` и `/v2`. Кольцо МКАД — `data/mkad-exact.geojson`.
- `traffic.py` — детерминированная модель пробок `moscow-radial-v1` с
  демо-расширением (МКАД/ТТК/Садовое в час пик ×2.6, магистрали ×1.8).
- `../route-engine3/graphs/car/` — готовый граф `moscow-mkad` (вырезка OSM
  внутри буфера МКАД), общий для обоих дорожных сервисов:
  `osrm-routed --algorithm mld`.
- `data/` — кольцо МКАД для классификации точек.

`/matrix2?planning=1&points=lat,lon;lat,lon&departure=<epoch>` возвращает дорожные
стоимости для поиска: `forecast_band_starts` (локальные минуты, Europe/Moscow),
`model_version`, `forecast_timezone` и `matrix[i][j].forecast_duration_s`.
Элементы массива соответствуют границам режимов прогноза; `base_duration_s`
используется при выключенных пробках. Единицы: секунды и метры. `unreachable`
сохраняет отсутствие пути, `straight`/`out_of_scope` требуют регионального fallback.
Холодный запрос делает один OSRM `/table`; поисковый цикл не вызывает `/route2`.
Точный поэтапный прогноз и полилинии выбранных плеч остаются в `/route2`.

Источник и пайплайн пересборки графа: проект
`~/Projects/LCT/moscow-road-graph` (`scripts/pipeline.sh`: mkad → extract →
graph → serve; тяжёлая обработка OSM — pyosmium на хосте).

> **Преемник:** контракты v3 (`/route3`, `/matrix3`, `/metro3`), пешеходный
> граф и универсальная загрузка графов — в отдельном юните
> [`services/route-engine3`](../route-engine3/README.md) (документ
> `docs/route3.md`); графы обоих сервисов вендорятся в одном месте
> (`services/route-engine3/graphs/`).

## Локально

```bash
docker compose -f infra/docker-compose.yml up -d osrm road-api
docker compose -f infra/docker-compose.yml exec -T road-api python3 -c \
  'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8123/route2?a=55.7520,37.6175&b=55.7600,37.6300").read().decode())'
```

Команды выполняются из корня репозитория. Основной Compose не публикует порт
`road-api` на хост: `127.0.0.1:8123` внутри приведённой команды — loopback контейнера.
Контейнер раскладывает код в `/srv/demo`, полигон в `/srv/data` и задаёт
`OSRM_URL=http://osrm:5000`. Это согласованное дерево из Dockerfile и Compose.
Для нативного запуска нужно отдельно подготовить такую же относительную раскладку
`demo/` + `data/`: `server.py` ищет полигон в `../data/` относительно своего файла.
Прямой запуск нынешнего файла из `services/road-api/` без этой подготовки ищет
несуществующий `services/data/mkad-exact.geojson` и завершится до старта HTTP.

`/health` отвечает `{"osrm": true}`, когда граф прогрет. После старта
первые запросы могут быть медленными (прогрев страниц графа) — healthcheck
это учитывает.
