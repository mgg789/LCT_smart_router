# Контракты «фронт ↔ бэк» для нового фронтенда

> Самодостаточный документ для разработчика фронтенда: всё, что нужно для подключения
> к System Layer (`apps/api`) — аутентификация, конвенции, каждый эндпоинт с телом
> запроса и формой ответа, справочники и типовые потоки.
> Источник истины: контроллеры `apps/api/src/api/` (Swagger: `http://localhost:8000/docs`).
> См. также [web.md](./web.md) — заметки по текущему дашборду — и
> [api.md](./api.md) — серверные конвенции глубже.

---

## 1. Базовые сведения

| Параметр | Значение |
|---|---|
| Base URL (compose) | `http://127.0.0.1:8000` (дашборд из контейнера ходит через nginx → `api:8000`) |
| Base URL (dev без Docker) | пустой `VITE_API_BASE` → Vite проксирует `/api` на `127.0.0.1:8000` |
| Prefix | все API-маршруты — `/api/v1/...`; health — вне префикса |
| Swagger | `http://localhost:8000/docs` (интерактив), `/docs/openapi.json` (машиночитаемо) |
| Формат | JSON в теле запроса и ответа; поля — camelCase |
| Время | **целые секунды Unix** (число). Никаких ISO-строк и миллисекунд; локальный рендеринг — на клиенте, с явной зоной (`Europe/Moscow`) |
| Статус-коды | `GET`/`PATCH`/`PUT` → 200, `POST` → 201, ошибки — см. §3 |

Роли: `client`, `engineer`, `dispatcher`. Дашборд — весь контур `dispatch/*` — требует
роль `dispatcher`. Доступ по bearer-токену в заголовке:

```
Authorization: Bearer <token>
```

## 2. Аутентификация

| Метод | Путь | Тело | Ответ | Заметки |
|---|---|---|---|---|
| POST | `/api/v1/auth/dispatcher/password` | `{email, password}` | `{token, role: "dispatcher", expiresAt}` | Публичный. Пароль диспетчера задаётся в `.env` (`DISPATCHER_EMAIL`/`DISPATCHER_PASSWORD`); SMTP не нужен |
| POST | `/api/v1/auth/login-code` | `{email}` | `{email, expiresAt, devCode?}` | Публичный. Ответ одинаковый для известного и неизвестного адреса. `devCode` появляется только при `AUTH_DEV_EXPOSE_CODES=true` (нет SMTP-шлюза) |
| POST | `/api/v1/auth/login-code/verify` | `{email, code: "123456", role}` | `{token, role, expiresAt}` | `role` ∈ `client/engineer/dispatcher`; роль `engineer` выдаётся только существующему инженеру |
| GET | `/api/v1/auth/session` | — | `{kind, source, role, accountId, tokenCategory}` | Кто за предъявленным токеном |
| DELETE | `/api/v1/auth/session` | — | `{signedOut: true}` | Идемпотентный выход |

Токен — bearer-сессия; храните в памяти/`sessionStorage`, уважайте `expiresAt`.
Интеграционные ключи (`POST /auth/tokens`, категории `client/eng/master`) фронтенду
не нужны — это машинный доступ.

## 3. Ошибки: один конверт

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "…",
    "details": { "…": "…" },
    "requestId": "0f0f…"
  }
}
```

Код — контракт, статус — следствие. Держите различение по коду, не по числу:

| Код | HTTP | Когда |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Тело не прошло схему; `details.issues` — список проблемных путей |
| `UNAUTHENTICATED` | 401 | Нет/просрочен токен → показать вход |
| `FORBIDDEN` | 403 | Роль не подходит (например, сброс данных не из сессии диспетчера) |
| `NOT_FOUND` | 404 | Объекта нет или он не виден этому актору |
| `VERSION_CONFLICT` | 409 | Объект изменился после чтения → перезагрузить и подтвердить снова |
| `OPERATION_ID_REUSED` | 409 | Тот же `operationId` с другими аргументами — баг клиента |
| `WORK_ALREADY_STARTED` | 409 | По заявке есть факт начала — правки/перенос/отмена закрыты |
| `MODE_MANUAL` / `MODE_AUTO` | 409 | Действие принадлежит другому режиму управления |
| `SNAPSHOT_STALE` | 409 | Результат относится к уже неактуальному снимку (серверный путь) |
| `RESULT_NOT_APPLICABLE` | 409 | Результат готов, но не должен становиться планом |
| `SERVICE_NOT_CONFIGURED` | 503 | Зависимость не подключена (Router Core выключен) |
| `INTERNAL_ERROR` | 500 | Смотреть логи по `requestId` |

## 4. Конверт операций (все записи)

Каждое изменяющее действие принимает конверт рядом со своими полями:

| Поле | Тип | Смысл |
|---|---|---|
| `operationId` | UUID | Стабильный id намерения. **Повтор с тем же `operationId` и теми же аргументами возвращает первый исход, не повторяя работу** — ретраи безопасны |
| `expectedVersion` | число, опционально | `version` объекта, который вы видели; если объект изменился — `VERSION_CONFLICT` с версиями в `details` |

Практика: генерируйте `operationId` (uuid v4) на каждое намерение пользователя; при
сетевой ошибке повторяйте запрос с тем же id; при `VERSION_CONFLICT` перечитывайте
объект (поле `version` в каждом view) и просите пользователя подтвердить заново.

## 5. Справочники и энумы

| Поле | Значения |
|---|---|
| `lifecycle` | `draft` → `submitted` → `in_progress` → `completed` / `cancelled` |
| `assignmentState` | `pending` (ждёт актуального расчёта — **не** отказ) / `assigned` / `unassigned` |
| `priority` | `normal` / `urgent` |
| Навык `requiredSkill` / `skills` | `local` / `connection` / `emergency` |
| Транспорт `transportType` | `car` / `walk` / `bike` / `transit` |
| Оборудование `requiredEquipment` | `router` / `set_top_box` / `smart_speaker` / null |
| `availability` | `online` / `offline` |
| `origin` плана | `auto` / `manual` |
| Серьёзность alert | `info` / `warning` / `error` |
| Политики `policyId` | `fast`, `compact` (**дефолт**), `sla`, `balanced`, `eco` |

## 6. Диспетчерский контур `/api/v1/dispatch/...` (роль `dispatcher`)

### 6.1 Заявки

**GET `/dispatch/requests?lifecycle=&assignment=`** → `{requests: RequestView[]}`
Полный день: включает начатые, завершённые и отменённые. Фильтры необязательны.

`RequestView`:

```json
{
  "id": "req-…", "version": 3,
  "lifecycle": "in_progress", "assignmentState": "assigned",
  "addressText": "…", "region": "east", "lat": 55.75, "lon": 37.62,
  "needsGeocoding": false, "geocodeQuality": "address_match",
  "workType": "Заявка на подключение", "workTypeTitle": "Заявка на подключение",
  "requiredSkill": "connection", "requiredEquipment": "router",
  "normProfileCode": "connection_base",
  "normativeTravelDurationSec": 1200,
  "technicalDurationSec": 3600, "documentationDurationSec": 600,
  "serviceDurationSec": 4200,
  "actualDurationSec": null, "durationVarianceSec": null,
  "windowStartAt": 1789459200, "windowEndAt": 1789462800,
  "priority": "normal",
  "contactName": "…", "problemText": "…",
  "createdAt": 1789450000, "submittedAt": 1789450100,
  "startedAt": null, "expectedCompletionAt": null,
  "continuationAvailableAt": null, "overrunDetectedAt": null,
  "completedAt": null, "cancelledAt": null
}
```

`version` возвращайте обратно как `expectedVersion` при изменении. Поля
`startedAt…completedAt` — execution-тайминг: `expectedCompletionAt` ставится фактом
«начато», `overrunDetectedAt` — координатором превышений, `continuationAvailableAt` —
когда инженер реально освободится.

**POST `/dispatch/requests`** — создать заявку от имени клиента (сразу отправлена):

```json
{
  "operationId": "<uuid>", "clientEmail": "client@example.test",
  "contactName": "Иван", "addressText": "ул. …, д. 1",
  "lat": 55.75, "lon": 37.62,
  "workType": "Заявка на подключение",
  "requiredEquipment": "router",
  "windowStartAt": 1789459200, "windowEndAt": 1789462800,
  "urgent": false, "problemText": "…"
}
```
→ `{request: RequestView}`. Навык/длительность/профиль нормы выводятся из `workType`.

**PATCH `/dispatch/requests/:id`** — изменить условия неначатой заявки:
`{operationId, expectedVersion?, windowStartAt?, windowEndAt?, addressText?, lat?, lon?, urgent?, requiredEquipment?}` (хотя бы одно поле) → `{request}`.

**POST `/dispatch/requests/:id/cancel`** — `{operationId, expectedVersion?, reason?}` → `{request}`. Неначатую; иначе `WORK_ALREADY_STARTED`.

**GET `/dispatch/requests/:id/history`** → `{history: [{changedAt, operationId, reason, previous}], asOf}` — журнал прежних условий.

### 6.2 Инженеры

**GET `/dispatch/engineers`** → `{engineers: [EngineerView & {day: EngineerDayView|null}]}`

```json
{
  "id": "eng-…", "version": 2, "displayName": "Бригада Иванов",
  "inputOrder": 0, "skills": ["connection", "emergency"],
  "transportType": "car", "region": "east",
  "homeLat": 55.77, "homeLon": 37.65, "hasAccount": false,
  "day": {
    "engineerId": "eng-…", "workDate": "2026-09-17", "version": 5,
    "shiftStartAt": 1789455600, "shiftEndAt": 1789488000,
    "availability": "online", "expectedOnlineAt": null,
    "equipmentStock": {"router": 3, "setTopBox": 1, "smartSpeaker": 0},
    "equipmentIssuedAt": 1789456000,
    "lunch": {"enabled": false, "durationSec": null, "windowStartAt": null,
               "windowEndAt": null, "required": false, "taken": false, "startedAt": null}
  }
}
```

`day` — последний известный рабочий день (может быть `null`). Профиль, доступность
и прогресс работы — три разных вещи, не смешивать в один статус.

**POST `/dispatch/engineers`** — `{operationId, email, displayName, skills[1..3], transportType, region?, homeLat?, homeLon?}` → `{engineer}`.

**PATCH `/dispatch/engineers/:id`** — `{operationId, expectedVersion?, displayName?, skills?, transportType?, region?, homeLat?, homeLon?}` → `{engineer}`.

**POST `/dispatch/engineers/:id/workday`** — `{operationId, workDate: "YYYY-MM-DD", shiftStartAt, shiftEndAt, lunch?: {enabled, durationSec?, windowStartAt?, windowEndAt?}, lunchRequired?}` → `{day}`. Включённый обед требует длительность и полное окно, обед помещается в окно целиком.

**POST `/dispatch/engineers/:id/availability`** — `{operationId, availability: "online"|"offline", expectedOnlineAt?}` → `{day, publication: {publicationId, inputHash, planningAsOf}|null}`. Доступность не завершает и не переназначает работу в руках. `publication` — снимок, который эта публикация породила.

**POST `/dispatch/engineers/:id/technical-break`** — `{operationId}` → `{day}`. Техостановка 15 минут, день уходит в offline.

### 6.3 Политики и сравнение

**GET `/dispatch/policies`** → `{policies: [{policyId, title, description, isDefault}], active: {policyId, version, changedAt}}`.

**GET `/dispatch/policy-comparison`** → сравнение всех политик + FIFO-базы **на текущей опубликованной раскладке**:

```json
{
  "inputPublicationId": "…", "inputHash": "…", "routerContextVersion": "…",
  "computedAt": 1789460000, "searchBudgetMs": 8000,
  "rows": [
    {"strategyId": "compact", "kind": "policy", "isUsable": true, "calculationMs": 740,
     "metrics": {"requestsTotal": 66, "assignedCount": 64, "unassignedCount": 2,
                  "urgentTotal": 13, "urgentAssignedCount": 12, "engineersUsed": 11,
                  "distanceKm": 91.5, "travelTimeSec": 77156, "workTimeSec": 250000,
                  "waitingTimeSec": 4300, "lunchTimeSec": 0}},
    {"strategyId": "baseline", "kind": "baseline", "isUsable": true, "calculationMs": 60, "metrics": {"…": "…"}}
  ]
}
```

`rows` — шесть штук: пять политик (`kind: "policy"`) + `baseline` (FIFO по ТЗ,
`kind: "baseline"`). Ответ 503 (`SERVICE_NOT_CONFIGURED`), если Router Core не
подключён, и 409 `VERSION_CONFLICT`, если данные изменились, пока считалось, —
просто перечитать. Тяжёлый эндпоинт: кэшируйте на клиенте и не дёргайте в цикле.

**POST `/dispatch/policy`** — `{operationId, policyId}` → `{policyId, …, publication}`. Выбор публикует новую задачу; план на экране сменится после приёмки нового результата.

### 6.4 Технастройки Router (обеды, допуски, дорога)

**GET `/dispatch/router/technical-settings`** →

```json
{
  "lunchesEnabled": false,
  "departureLatenessToleranceSec": 0,
  "taskStartLatenessToleranceSec": 0,
  "travelTimeMode": "graph_with_access_buffer",
  "accessBufferSec": 600,
  "fixedTravelTimeSec": 1200,
  "earlyFinishReplanThresholdSec": 900,
  "taskOverrunToleranceSec": 600,
  "routerContextVersion": "<sha256>"
}
```

**PUT `/dispatch/router/technical-settings`** — полная замена ревизии:

```json
{"operationId": "<uuid>", "expectedContextVersion": "<из GET>", "lunchesEnabled": false,
 "departureLatenessToleranceSec": 0, "taskStartLatenessToleranceSec": 0,
 "travelTimeMode": "graph_with_access_buffer", "accessBufferSec": 600,
 "fixedTravelTimeSec": 1200, "earlyFinishReplanThresholdSec": 900,
 "taskOverrunToleranceSec": 600}
```
→ `{...те же 8 полей, operationId, status: "accepted", routerContextVersion}`.
CAS по `expectedContextVersion`: устарели — 409 `VERSION_CONFLICT`, перечитать GET.
Каждое поле ограничено 0…86400. Обеды включаются здесь же (`lunchesEnabled: true`).

### 6.5 План дня и режим управления

**GET `/dispatch/plan`** — главный эндпоинт экрана «день»:

```json
{
  "mode": "auto", "modeVersion": 4,
  "plan": {
    "revision": 12, "origin": "auto",
    "planAsOf": 1789459200, "appliedAt": 1789459260,
    "routes": [{
      "engineerId": "eng-…", "startLat": 55.77, "startLon": 37.65,
      "startAt": 1789455600, "finishAt": 1789480000,
      "distanceKm": 41.2, "travelTimeSec": 5400, "workTimeSec": 25200,
      "waitingTimeSec": 900, "lunchTimeSec": 0, "assignedCount": 6,
      "lunchStatus": "not_scheduled",
      "stops": [{"sequence": 0, "kind": "job", "requestId": "req-…",
                  "lat": 55.75, "lon": 37.62,
                  "arrivalAt": 1789456200, "startAt": 1789456260, "endAt": 1789460460}]
    }],
    "assignments": [{"requestId": "req-…", "status": "assigned", "engineerId": "eng-…",
                      "reasons": [{"code": "skill_match", "text": "…",
                                    "basis": "constraint_check", "facts": {…}}]}]
  },
  "appliedResult": {"resultId": "…", "inputHash": "…", "routerContextVersion": "…"},
  "lastResult": {"resultId": "…", "inputHash": "…", "routerContextVersion": "…",
                  "accepted": true, "rejectionCode": null, "receivedAt": 1789459255}
}
```

- `plan: null` — план ещё не применялся (честное пустое состояние, не ошибка).
- `planAsOf` показывать рядом с планом: пока идёт пересчёт, план на экране остаётся
  со своим моментом, пометка «Перестраивается».
- `lastResult.accepted: false` + `rejectionCode` — почему последний расчёт не стал
  планом (`SNAPSHOT_STALE`, `RESULT_NOT_APPLICABLE`, …).
- Ожидание обновлений: **SSE нет** — опрашивайте `GET /plan` (текущий дашборд
  перечитывает после действий и по таймеру; интервал 2–5 с достаточен). `modeVersion`
  меняется при переключении режима.

`kind` остановки: `job` / `lunch` / `wait`; `arrivalAt ≤ startAt ≤ endAt` — расчётные
значения, не факты.

**POST `/dispatch/mode`** — `{operationId, mode: "auto"|"manual"}` → `{control}`. В MANUAL автоматические результаты не применяются.

**POST `/dispatch/plan/reassign`** — `{operationId, requestId, engineerId}` — перенос неначатой работы (ручной режим).

**POST `/dispatch/plan/reorder`** — `{operationId, engineerId, requestIds: [...]}` — зафиксировать порядок очереди инженера.

### 6.6 Алерты

**GET `/dispatch/alerts`** → `{alerts: [{id, code, severity, engineerIds, requestIds, reasons, restoreOption, createdAt, seenAt, resolvedAt}]}` (до 200, свежие сверху).
**POST `/dispatch/alerts/:id/seen`** → `{seen: true}`. «Seen» ≠ «resolved»: состояние исчезнет, когда уйдёт причина.

### 6.7 Данные: импорт, догрузка, сброс

**GET `/dispatch/data/state`** →

```json
{"initialized": true, "startupProfile": "demo", "generation": 7,
 "availableRegions": ["east", "south_central", "southeast"],
 "imports": [{"source": "official-dataset", "checksum": "…", "appliedAt": 1789450000,
               "summary": {"applied": true, "requestsCreated": 66, "engineersCreated": 12,
                            "depotsCreated": 1, "requestsSkippedAsDuplicate": 0,
                            "requestsWithoutCoordinates": 0, "warnings": [], "errors": []}}]}
```

**POST `/dispatch/data/import`** — официальный CSV-датасет, атомарно по всем регионам:

```json
{"operationId": "<uuid>", "regions": "all"}
```
`region: "east"` **или** `regions: "all" | ["east","southeast"]`, опционально
`engineerCountPerRegion: {"east": 15}` (больше фактических бригад — 422). →
`{…, regionResults: [{region, source, applied, requestsCreated, engineersCreated, depotsCreated, requestsSkippedAsDuplicate, requestsWithoutCoordinates, warnings, errors}]}`.
Повтор того же пакета не плодит заявки: окна и смены переносятся на сегодняшний горизонт
(`applied: true`, warning про rebase).

**POST `/dispatch/data/upload`** — JSON-пакет: новый регион или догрузка заявок.

```json
{"operationId": "<uuid>", "schemaVersion": "1.0", "mode": "new_region",
 "region": "my_region", "sourceVersion": "v1",
 "requests": [{"externalId": "r-1", "addressText": "…", "lat": 55.7, "lon": 37.6,
                "serviceDurationSec": 3600, "windowStartAt": 1789459200,
                "windowEndAt": 1789462800, "priority": "normal",
                "requiredSkill": "connection", "requiredTransport": "car",
                "requiredEquipment": "router", "workType": "…"}],
 "engineers": [{"externalId": "e-1", "displayName": "…", "skills": ["connection"],
                 "transportType": "car", "start": {"lat": 55.7, "lon": 37.6},
                 "shiftStartAt": 1789455600, "shiftEndAt": 1789488000}],
 "depot": {"addressText": "…", "lat": 55.7, "lon": 37.6}}
```
`mode: "new_region"` требует `engineers` и `depot`; `"append_requests"` запрещает их.
Координаты обязательны — ничего не геокодируется и не выдумывается.

**POST `/dispatch/data/reset`** — только из сессии диспетчера (не интеграционный ключ):

| Тело | Что делает |
|---|---|
| `{operationId, kind: "demo", confirmation: "reset to test data"}` | Сброс к тестовому набору |
| `{operationId, kind: "empty", confirmation: "erase all application data"}` | Полный сброс «всё в ноль» |

Без точной фразы подтверждения — отказ; после сброса сессии живут, данные пусты.

### 6.8 Отладочные

**GET `/dispatch/debug/snapshot`** — опубликованная задача ровно как её читает Router:
`{published, publicationId, publicationSeq, inputHash, planningAsOf, trigger, generation, diagnostics, diagnosticsAtPublication, payload}`. `published: false` + `diagnostics` — валидное состояние «ещё ничего не менялось». `diagnostics` живые:
`requestsWithoutLocation`, `requestsOutsideHorizon`, `engineersWithoutStartLocation`,
`engineersWithoutShift`, `engineersWithoutWorkday`, `engineersOverrun`. Полезно для
экрана «почему в задаче не всё».

**POST `/dispatch/debug/router-result`** — тестовый вход приёмки результата; продукту не нужен.

## 7. Контур инженера `/api/v1/engineer/...` (роль `engineer`)

Всё действует на инженера из токена (без параметров «чужого» id):

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/engineer/profile` | → `{engineer: EngineerView}` |
| PATCH | `/engineer/profile` | `{operationId, expectedVersion?, displayName?, skills?, transportType?, homeLat?, homeLon?}` → `{engineer}` |
| GET | `/engineer/day` | → `{day: EngineerDayView}` |
| POST | `/engineer/availability` | `{operationId, availability, expectedOnlineAt?}` → `{day}` |
| POST | `/engineer/technical-break` | `{operationId}` → `{day}` |
| POST | `/engineer/lunch/start` · `/finish` | `{operationId}` → `{day}` |
| GET | `/engineer/plan` | → `{planAsOf, origin, revision, route: PlanRouteView|null}` — свой маршрут применённого плана |
| POST | `/engineer/requests/:id/facts` | `{operationId, kind: "arrived"\|"arrived_blocked"\|"started"\|"finished"\|"problem", occurredAt?, note?}` → факт исполнения; отмечать можно только то, что назначено применённым планом; финиш без старта — 422 |

## 8. Контур клиента `/api/v1/client/...` (роль `client`)

`GET /client/work-types` → `{workTypes: [{code, title}]}` — каталог типов работ (выбор
в форме; код = ключ для `POST .../requests {workType}`). `POST /client/requests`
(черновик) → `POST /client/requests/:id/submit` (подтверждение) → заявка становится
задачей; `POST /client/requests/:id/reschedule`; `GET /client/requests`,
`GET /client/requests/:id` — только свои заявки. Тела — как §6.1 минус `clientEmail`.

## 9. Health (вне `/api/v1`, без авторизации)

`GET /health/live` → процесс жив. `GET /health/ready` → 503, если недоступна БД.
`GET /health/services` → `{services: {postgres, router, ai, smtp: {status: "up"|"not_configured"|"down"}}}` — используйте, чтобы честно показать состояние контура.

## 10. Объяснения: причины назначений

`assignments[].reasons` (и `routes[].reasons`, и `alerts[].reasons`) — массив причин
от решателя, не текст для показа как есть:

```json
{"code": "skill_match", "text": "english evidence", "basis": "constraint_check", "facts": {"…": 1}}
```

`basis`: `constraint_check` (проверенное ограничение) / `calculation_outcome` (исход
ограниченного поиска — не доказательство невозможности). Известные коды и их русский
рендер (как в текущем дашборде, `apps/web/src/lib/reasons.ts`): `skill_match`,
`skill_missing`, `equipment_ok`, `equipment_missing`, `travel_delta`, `sla_margin`,
`window_tight`, `load_balance`, `cluster`, `urgent_priority`; неназначение:
`NO_SKILL_MATCH`, `NO_TRANSPORT_MATCH`, `NO_EQUIPMENT_STOCK`, `NO_AVAILABLE_ENGINEER`,
`NO_FEASIBLE_ASSIGNMENT_FOUND`; обед: `LUNCH_NOT_PLACED`, `LUNCH_SKIPPED_FOR_WORK`,
`REQUIRED_LUNCH_UNPLACED`; общее: `CONSTRAINTS_SATISFIED`. Незнакомый код показывайте
как есть, не выдумывая формулировку.

## 11. Типовой поток дашборда

1. `POST /auth/dispatcher/password` → токен; `GET /health/services` — баннер состояния.
2. `GET /dispatch/data/state` → если `initialized: false` — экран импорта
   (`POST /dispatch/data/import {regions:"all"}`).
3. `GET /dispatch/requests` + `GET /dispatch/engineers` + `GET /dispatch/plan` — день.
4. `GET /dispatch/alerts`; неназначенные — из `plan.assignments` (`status: "unassigned"`)
   с причинами из §10.
5. Действия: выбор политики, технастройки, перенос/перестановка (MANUAL), создание/
   правка заявок, отключение инженера — каждый вызов с новым `operationId`.
6. Обновление: polling `GET /dispatch/plan` (+ `requests`, `alerts`) — SSE пока нет.
7. Сравнение политик: `GET /dispatch/policy-comparison` по кнопке (тяжёлый), 409 — перечитать.

## 12. Что важно не сломать

- Время — только целые секунды; таймзона — только на рендере.
- `operationId` на каждое намерение; ретрай — тем же id.
- Три состояния заявки (`lifecycle`, `assignmentState`, факты) не смешивать.
- `pending` — «ждёт расчёта», не ошибка и не «не назначена».
- Координаты не выдумывать: пустые — это диагностика, а не повод поставить точку.
- Объяснения — только из `reasons` по кодам; никаких собственных «объяснений алгоритма».
