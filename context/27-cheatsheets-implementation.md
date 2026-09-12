# Шпаргалки реализации: copy-paste сниппеты для старта

> Назначение: минимальные рабочие заготовки для каждой подсистемы, чтобы любой агент не тратил время на boilerplate. Сниппеты компактные и проверенные по структуре, но точные сигнатуры API сверяйте с официальной документацией (ссылки в `30-sources-index.md`). Связанные файлы: `05` (солвер), `06` (OSRM/гео), `09` (архитектура), `20–24` (вспомогательные API).

---

## 1. Каркас монорепо (pnpm)

```bash
mkdir lct-fsm && cd lct-fsm
pnpm init && pnpm add -w typescript turbo
mkdir -p apps/{web,api,solver} packages/shared data/{aux,seed} infra
# apps/web: pnpm create vite@latest web -- --template react-ts
# packages/shared: общий пакет типов (zod) — источник контрактов (см. 09 §5)
```

`infra/docker-compose.yml` (минимум):

```yaml
services:
  osrm:
    image: ghcr.io/project-osrm/osrm-backend:latest
    command: osrm-routed --algorithm mld --max-table-size 10000 /data/moscow.osrm
    volumes: [ "./data/osrm:/data" ]
    ports: [ "5000:5000" ]
  postgres:
    image: postgis/postgis:16-3.4        # достаточно и без postgis, если не нужны GEOGRAPHY
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: fsm }
    ports: [ "5432:5432" ]
  api:   { build: ../apps/api,   ports: [ "8000:8000" ], depends_on: [postgres, osrm] }
  solver:{ build: ../apps/solver, ports: [ "8100:8100" ] }
```

## 2. OSRM: подготовка данных города + запросы

```bash
# вырезка города из Geofabrik-выгрузки (детали: context/06 §3)
osmium extract russia-latest.osm.pbf -b 37.2,55.45,37.95,55.95 -o moscow.osm.pbf
docker run -t -v "$(pwd)/data/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest osrm-extract -p /opt/car.lua /data/moscow.osm.pbf
docker run -t -v "$(pwd)/data/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest osrm-partition /data/moscow.osrm
docker run -t -v "$(pwd)/data/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest osrm-customize /data/moscow.osrm
# координаты в /table — порядок lon,lat!
curl "http://localhost:5000/table/v1/driving/37.61,55.75;37.54,55.79?annotations=duration"
curl "http://localhost:5000/route/v1/driving/37.61,55.75;37.54,55.79?overview=full&geometries=geojson"
```

Матрица → минуты (Python, батч):

```python
import requests, math
def matrix(points, base="http://localhost:5000"):
    coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in points)  # (lat,lon) -> lon,lat
    r = requests.get(f"{base}/table/v1/driving/{coords}",
                     params={"annotations": "duration"}).json()
    return [[math.ceil(d/60) for d in row] for row in r["durations"]]  # минуты, ceil
```

## 3. OR-Tools: минимальная модель VRPTW + навыки + перерывы

```python
from ortools.constraint_solver import pywrapcp, routing_enums_pb2 as en

def solve(n_nodes, starts, ends, travel_min, service_min, requests, engineers):
    """travel_min[(a,b)] — матрица в минутах; requests: {node: (tw_open, tw_close, allowed_engs)}"""
    mgr = pywrapcp.RoutingIndexManager(n_nodes, len(engineers), starts, ends)
    routing = pywrapcp.RoutingModel(mgr)

    def cb(i, j):                      # время = путь + сервис в узле отправления
        a, b = mgr.IndexToNode(i), mgr.IndexToNode(j)
        return int(travel_min[a][b] + service_min.get(a, 0))
    t_idx = routing.RegisterTransitCallback(cb)
    routing.AddDimension(t_idx, 60, 24 * 60, True, "time")   # slack=60: ожидание до 1 ч
    time_dim = routing.GetDimensionOrDie("time")

    for node, (o, c, engs) in requests.items():
        idx = mgr.NodeToIndex(node)
        time_dim.CumulVar(idx).SetRange(o, c)                    # окно
        if len(engs) < len(engineers):                           # навык/оборудование/транспорт
            routing.SetAllowedVehiclesForIndex(engs, idx)

    for e, eng in enumerate(engineers):
        time_dim.CumulVar(routing.Start(e)).SetValue(eng["shift_start"])
        time_dim.CumulVar(routing.End(e)).SetMax(eng["shift_end"])

    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = en.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    search.local_search_metaheuristic = en.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.FromMilliseconds(1500)

    sol = routing.SolveWithParameters(search)
    routes = {}
    for e in range(len(engineers)):
        idx, route = routing.Start(e), []
        while not routing.IsEnd(idx):
            route.append((mgr.IndexToNode(idx),
                          time_dim.CumulVar(idx).Min(),
                          time_dim.SlackVar(idx).Min()))
            idx = sol.Value(routing.NextVar(idx))
        routes[e] = route
    return routes   # (узел, время прибытия, slack=ожидание) → сырьё для причин (11 §2)
```

Дополнения по мере зрелости: мягкие окна (`SetCumulVarSoftUpperBound` с штрафом — SLA), перерывы на обед (`routing.SetBreakIntervalsOfVehicle(intervals, e, node_visit_transits)`), тёплый старт (`routing.ReadAssignmentFromRoutes(prev_routes, True)` → `SolveFromAssignmentWithParameters`). Детали — `05` §2–3, `07` §5, официальные примеры Vehicle Routing.

## 4. MapLibre: подложка + слой маршрутов

```ts
import maplibregl from "maplibre-gl";
// Основная подложка — Яндекс Tiles (бесплатный ключ из ЛК, context/20 §1);
// точный шаблон URL берётся из личного кабинета. Резерв — CARTO Voyager.
const yandexRaster = { version: 8, sources: { base: {
    type: "raster",
    tiles: ["<TILES_URL_FROM_YANDEX_LK>"], tileSize: 256, attribution: "© Яндекс" }},
  layers: [{ id: "base", type: "raster", source: "base" }] };
// CARTO (резерв): style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
const map = new maplibregl.Map({ container: "map", style: yandexRaster,
  center: [37.62, 55.75], zoom: 10 });

// маршрут инженера — по геометрии из OSRM /route
map.on("load", () => {
  map.addSource("route-0", { type: "geojson",
    data: { type: "Feature", properties: {}, geometry: routeGeometry } });
  map.addLayer({ id: "route-casing-0", type: "line", source: "route-0",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 8 } });
  map.addLayer({ id: "route-line-0", type: "line", source: "route-0",
    paint: { "line-color": "#0f62fe", "line-width": 4 } });
});
```

## 5. SSE: события плана (сервер FastAPI + клиент TS)

```python
# сервер: асинхронная очередь на клиента (или broadcast)
import asyncio, json
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
app, subs = FastAPI(), set()
async def events():
    q: asyncio.Queue = asyncio.Queue()
    subs.add(q)
    try:
        while True: yield f"data: {json.dumps(await q.get())}\n\n"
    finally: subs.remove(q)
@app.get("/api/stream")
def stream(): return StreamingResponse(events(), media_type="text/event-stream")
async def publish(evt: dict):          # вызывать после сохранения плана
    for q in list(subs): await q.put(evt)
# publish({"type": "plan.updated", "planId": ..., "diff": {...}, "solveMs": 812})
```

```ts
// клиент: авто-реконнект из коробки
const es = new EventSource("/api/stream");
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  if (evt.type === "plan.updated") showPlanDelta(evt);   // дельта-анимация (10 §4)
};
```

## 6. Telegram-бот инженера (aiogram 3, минимум)

```python
import asyncio
from aiogram import Bot, Dispatcher, F
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton as IKB

bot, dp = Bot("TELEGRAM_TOKEN"), Dispatcher()

@dp.message(F.text.startswith("/day"))
async def day(msg: Message):
    plan = get_engineer_day(msg.chat.id)               # из API продукта
    await msg.answer(plan.text, parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            IKB(text="Выехал", callback_data=f"start:{plan.next_visit}"),
            IKB(text="На месте", callback_data=f"arrive:{plan.next_visit}")]]))

@dp.callback_query(F.data.startswith("start:"))
async def departed(cb):
    post_status(cb.data.split(":")[1], "driving")      # → симулятор/лента событий (07 §4)
    await cb.answer("Статус обновлён")
asyncio.run(dp.start_polling(bot))
```

## 7. Голосовой ввод: faster-whisper эндпоинт

```python
# apps/solver/asr.py: POST /asr (audio/webm) -> text; GPU PRO 6000, полная офлайн-работа
from fastapi import FastAPI, UploadFile
from faster_whisper import WhisperModel
app, model = FastAPI(), WhisperModel("large-v3", device="cuda", compute_type="float16")
@app.post("/asr")
async def asr(file: UploadFile):
    tmp = f"/tmp/{file.filename}"; open(tmp, "wb").write(await file.read())
    segs, _ = model.transcribe(tmp, language="ru", vad_filter=True)
    return {"text": " ".join(s.text for s in segs)}
# клиент: MediaRecorder -> fetch('/asr') -> текст -> существующий LLM-парсер заявки (08 §4)
```

## 8. Открытые данные: city-layers скрипт (выгрузка заранее, офлайн-демо)

```bash
# data.mos.ru (ключ бесплатный) — дорожные работы / отключения воды:context/22 §1–3
curl "https://apidata.mos.ru/v1/datasets/{ID}/rows?api_key=$MOS_KEY&\$top=1000" -o data/aux/roadworks.json
# погода на день (Open-Meteo, без ключа):context/22 §4
curl "https://api.open-meteo.com/v1/forecast?latitude=55.75&longitude=37.62&hourly=temperature_2m,precipitation,wind_speed_10m"
# Overpass: АЗС/кафе/туалеты/парковки Москвы — context/21 §5 (готовый запрос)
curl -G "https://overpass-api.de/api/interpreter" --data-urlencode 'data=[out:json][timeout:60];node["amenity"="fuel"](55.45,37.2,55.95,37.95);out body;'
# 2GIS Directions с трафиком (демо-ключ):context/20 §3.1
curl -X POST "https://routing.api.2gis.com/carrouting/6.0.0/global?key=$G2_KEY" -H 'Content-Type: application/json' -d '{"points":[{"type":"stop","lon":37.61,"lat":55.75},{"type":"stop","lon":37.54,"lat":55.79}],"transport":"car","route_mode":"fastest","traffic_mode":"jam"}'
```

## 9. .ics-фид дня инженера

```ts
// apps/api: GET /api/engineers/:id/calendar.ics — подписка webcal (context/24 §2)
import ICS from "ical-generator";
const cal = ICS({ name: "План дня" });
plan.visits.forEach(v => cal.createEvent({
  uid: `${v.requestId}@fsm`,              // стабильный UID — апдейты без дублей
  start: v.etaFrom, end: v.etaTo,
  summary: `${v.workTypeName} — ${v.address}`,
  location: v.address,
  description: `Окно ${v.window}. Комплект: ${v.equipment}. ${v.trackUrl}` }));
return new Response(cal.toString(), { headers: { "Content-Type": "text/calendar" } });
```

## 10. Smoke-тест контура (обязательный gate каждого PR)

```bash
# 1) seed: подготовить демо-датасет      (pnpm seed)
# 2) матрица: 120×120 из OSRM            (curl /table | jq '.durations|length')
# 3) солвер: build plan на golden-датасете → метрики в допуске
#    (sla_ok_pct==100, solve_ms<2000, diff vs golden plan == 0 при фикс. seed)
# 4) SSE: new_request → plan.updated < 2s
# 5) UI: карта, таймлайн, панель причин отрисовались (скриншот в PR)
```

Golden-датасет: фикс. seed генератора (`14` §5.1) + сохранённый эталонный план; любой PR, ломающий эталон без объяснения, не мержится — детерминизм демо (`15` §1) важнее «лучшего плана».
