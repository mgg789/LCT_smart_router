# Импорт дорожных ресурсов

Диспетчер загружает дорожный ресурс через `POST /api/v1/dispatch/data/road-import`.
Запрос проходит обычную авторизацию роли `dispatcher` и журнал `operationId`; тот же
идентификатор передаётся в приватный Router Core. Повтор с тем же телом возвращает
`replayed`, а повтор с другим телом отклоняется.

Тело запроса:

```json
{
  "operationId": "uuid",
  "profile": "car",
  "source": "osrm-moscow-2026-09",
  "payloadBase64": "..."
}
```

`payloadBase64` содержит UTF-8 native JSON OSRM или gzip-сжатые байты. Core также
принимает raw binary на `/v1/road-import` с заголовками `X-Operation-Id` и
`X-Road-Profile`. Поддержаны OSRM `Table` (`durations`/`distances`) и `Route`
(`routes[].geometry`), переносимый объект `RoadGraph` с `nodes` и `edges`, а также
компактный self-contained формат `navix-road-overlay/v1`:

```json
{"format":"navix-road-overlay/v1","version":"moscow-2026-09","profile":"car","edges":[{"coordinates":[[37.60,55.70],[37.61,55.71]],"duration_sec":42,"distance_m":850,"geometry":[[37.60,55.70],[37.61,55.71]]}]}
```

Каждое ребро направленное. При добавлении нового профиля существующая пара
`source -> target` сохраняется, а профильная стоимость объединяется; повтор профиля,
расходящиеся расстояние или геометрия отклоняются. Координаты проверяются как WGS84,
длительности и расстояния — как целые неотрицательные значения. Приватный Core
принимает до 64 MiB распакованного входа; браузерный dispatcher endpoint ограничен
8 MiB исходных байтов; общий JSON-парсер API допускает envelope до 12 MiB.

Принятый overlay и журнал операций хранятся в одном атомарно заменяемом документе
`.router/road-import.json` (или в `--road-store` / `ROUTER_ROAD_GRAPH_PATH`). При
перезапуске он загружается автоматически. Импортированные точные координатные рёбра
используются первыми; все остальные маршруты продолжают обслуживаться исходным
графом или OSRM-провайдером. Поэтому импорт не заменяет базовую карту.
После активации `RouterRuntime` пересчитывает `router_context_version`; это меняет
плановый контекст и geometry/travel overlay вместе с cost graph, а не только отрисовку.
