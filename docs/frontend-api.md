# Контракты «фронт ↔ бэк» для нового фронтенда

Уточнение LIVE от 20.09.2026: вход в аккаунт не означает выход на смену; требуется
явное действие `online`. `on_time` больше не принимается. Поля `lineStartedAt`,
`noShowAt`, `lunchInterval` сохраняют историю независимо от версии маршрута.
Карточка ближайшей заявки использует `eta/start/finish/problem`; ETA можно сообщить
и после планового прибытия через модальное окно проблемы. Риск времени допускает
решение `keep_as_is`. Чат/поддержка и AI не подключены; кнопки не имитируют отправку.

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
| POST | `/api/v1/auth/dispatcher/password` | `{email, password}` | `{token, role: "dispatcher", expiresAt}` | Публичный запасной вход. Пароль диспетчера задаётся в `.env` (`DISPATCHER_EMAIL`/`DISPATCHER_PASSWORD`); SMTP не нужен. Основной путь дашборда — `login-code` + `verify` с `role: "dispatcher"` |
| POST | `/api/v1/auth/login-code` | `{email}` | `{email, expiresAt, devCode?}` | Публичный. Ответ одинаковый для известного и неизвестного адреса. `devCode` только в local development (`AUTH_DEV_EXPOSE_CODES=true` и не `DEMO_STAND`). На публичном стенде код уходит письмом, диспетчер входит паролем |
| POST | `/api/v1/auth/login-code/verify` | `{email, code: "123456", role}` | `{token, role, expiresAt}` | `role` ∈ `client/engineer/dispatcher`; роль `engineer` выдаётся только существующему инженеру |
| GET | `/api/v1/auth/session` | — | `{kind, source, role, accountId, tokenCategory}` | Кто за предъявленным токеном |
| DELETE | `/api/v1/auth/session` | — | `{signedOut: true}` | Идемпотентный выход |

Токен — bearer-сессия; уважайте `expiresAt`. Дашборд диспетчера хранит сессию в
`sessionStorage` (`SESSION_TTL_SEC`, по умолчанию сутки). Приложение инженера на
`/engineer/` хранит сессию в `localStorage` на устройстве (`ENGINEER_SESSION_TTL_SEC`,
по умолчанию 30 суток). Интеграционные ключи (`POST /auth/tokens`, категории
`client/eng/master`) фронтенду не нужны — это машинный доступ.

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

**POST `/dispatch/requests`** — создать заявку с дашборда (сразу отправлена):

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
`clientEmail` и `contactName` необязательны для компактной диспетчерской формы. Если
адрес не передан, заявка остаётся без клиентского аккаунта и событийные письма не
создаются; адрес и имя не заменяются фиктивными значениями. Компактная форма Figma
передаёт `lat`/`lon` из LocationIQ autocomplete (`GET /dispatch/geocode`) или
клика по OSM; без точки заявка не создаётся. `region` на сервере ставится
ближайшим геоцентром уже существующих заявок региона.

**PATCH `/dispatch/requests/:id`** — изменить условия неначатой заявки:
`{operationId, expectedVersion?, windowStartAt?, windowEndAt?, addressText?, lat?, lon?, urgent?, requiredEquipment?}` (хотя бы одно поле) → `{request}`.

**POST `/dispatch/requests/:id/cancel`** — `{operationId, expectedVersion?, reason?}` → `{request}`. Неначатую; иначе `WORK_ALREADY_STARTED`.

**GET `/dispatch/requests/:id/history`** → `{history: [{changedAt, operationId, reason, previous}], asOf}` — журнал прежних условий.

**GET `/dispatch/requests/:id/evidence`** → `{requestId, main, baseline}` — расчётные факты
и `candidates[]`/`blockers[]` по одной заявке из сохранённого пакета Router
(`RouterResult.payload.main_evidence`/`baseline_evidence`, реализованный контракт из §11).
`main`/`baseline` — это `RequestEvidence` (`core/contracts.py`) или `null`, если
применённый план не несёт пакета обоснований (более старый результат, или Router его не
вернул) — честная пустая форма, а не выдуманная. Поля внутри переданы как есть
(snake_case, как у Router), включая `reasons[].basis` — тот же `constraint_check`/
`calculation_outcome` из §11 — и `candidates[].blockers[]`, который отвечает «почему не
Петров» и «почему у Сидорова пусто». Пример:

```json
{
  "requestId": "req-1",
  "main": {
    "request_id": "req-1", "status": "unassigned",
    "priority": "normal", "required_skill": "connection",
    "required_transport": null, "required_equipment": null,
    "service_duration_sec": 900,
    "window_start_at": 1789459200, "window_end_at": 1789462800,
    "engineer_id": null, "stop_id": null, "predecessor_request_id": null,
    "arrival_at": null, "start_at": null, "end_at": null,
    "waiting_time_sec": null, "window_start_offset_sec": null,
    "window_end_margin_sec": null, "travel_time_sec": null, "distance_km": null,
    "reason_codes": ["NO_FEASIBLE_ASSIGNMENT_FOUND"],
    "reasons": [{"code": "NO_FEASIBLE_ASSIGNMENT_FOUND", "text": "…", "basis": "calculation_outcome", "facts": {}}],
    "candidates": [{
      "engineer_id": "eng-1", "label": "Иван Кузнецов",
      "skills": ["connection"], "transport_type": "car",
      "equipment_stock": null, "release_at": null, "shift_end_at": 1789480000,
      "skill_match": true, "transport_match": true, "equipment_match": true,
      "available": true, "solo_feasible": true,
      "append_at_route_end_feasible": false,
      "append_start_at": null, "append_end_at": null,
      "append_incremental_travel_time_sec": null, "append_incremental_distance_km": null,
      "assigned_job_count": 3, "blockers": ["current_route_append_infeasible"]
    }]
  },
  "baseline": null
}
```

### 6.2 Инженеры

**GET `/dispatch/engineers`** → `{engineers: [EngineerView & {day: EngineerDayView|null}]}`

```json
{
  "id": "eng-…", "version": 2, "displayName": "Бригада Иванов",
  "inputOrder": 0, "skills": ["connection", "emergency"],
  "transportType": "car", "region": "east",
  "homeLat": 55.77, "homeLon": 37.65, "hasAccount": false,
  "email": null,
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
и прогресс работы — три разных вещи, не смешивать в один статус. `email` — адрес
входа, когда он привязан (`hasAccount: true`); у импортированных бригад `null`.

**POST `/dispatch/engineers`** — `{operationId, email?, displayName, skills[1..3], transportType, region?, homeLat?, homeLon?}` → `{engineer}`. Без `email` создаётся только профиль маршрутизации (`hasAccount: false`); логин можно выдать позже через `link-account`.

**DELETE `/dispatch/engineers/:id`** — `{operationId, expectedVersion?}` → `{engineer}`. Мягко архивирует профиль, снимает роль инженера и отзывает его живые сессии. Исторические планы и факты сохраняют ссылку на профиль. Инженера на LIVE-линии или с незавершённой работой сначала нужно снять с линии и освободить.

**POST `/dispatch/engineers/link-account`** — `{operationId, engineerId, email}` → `{engineer}`. Выдать логин профилю без адреса (бригада из импорта): аккаунт создаётся, роль инженера выдаётся, параметры планирования не меняются. Повторная привязка и адрес, уже являющийся логином другого инженера, — `VALIDATION_FAILED`. После привязки инженер входит через `POST /auth/login-code` + `verify` с `role: "engineer"`.

**PUT `/dispatch/engineers/:id/email`** — `{operationId, expectedVersion?, email}` → `{engineer}`. Диспетчер заменяет привязанный логин из основной панели инженера. Сессии и роль старого адреса отзываются, новый адрес получает роль инженера; профиль, планы и параметры маршрутизации не меняются.

**POST `/dispatch/engineers/unlink-account`** — `{operationId, engineerId}` → `{engineer}`. Снимает логин: `hasAccount: false`, `email: null`, роль инженера удаляется, живые сессии инженера отзываются. Профиль и план не меняются. Новый `verify` с `role: "engineer"` на этот адрес — `401`.

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

`rows` — шесть штук: пять политик (`fast`, `compact`, `sla`, `balanced`, `eco`)
+ `baseline` (FIFO по ТЗ, `kind: "baseline"`). Покрывающая политика в эту таблицу
не входит: она синтезирует смены. Persisted `covering-*` из снимка в расчёт
сравнения не попадают. `searchBudgetMs` по умолчанию 8000 на стратегию; первый
ответ после публикации может идти до ~90 с (таймаут UI и HTTP-клиента API).
Пока обычный rebuild ещё считает, возможен 503 — повторить после плана.
Ответ 503 (`SERVICE_NOT_CONFIGURED`), если Router Core не подключён, и 409
`VERSION_CONFLICT`, если данные изменились, пока считалось, — просто перечитать.
Тяжёлый эндпоинт: кэшируйте на клиенте и не дёргайте в цикле.

**POST `/dispatch/policy`** — `{operationId, policyId}` → `{policyId, …, publication}`. Выбор публикует новую задачу; план на экране сменится после приёмки нового результата.

### 6.4 Технастройки Router (обеды, допуски, дорога)

В LIVE-ответах `workday` дополнен `finishedAt`, `completionReason` и `stats`.

Новый Figma-интерфейс инженера использует эти LIVE-контракты без отдельной локальной
машины состояний: до окна — `on_time`/`eta`, в открытом окне — `start`, в работе —
`finish`/`problem`. Задержка передаёт дополнительные секунды, остальные проблемы —
причину отмены (для оборудования также его тип). Обед и технический перерыв блокируют
карточки; завершение техперерыва отправляет `break_finish`. Вход авторизованного
инженера в запущенный день отправляет `online`, включая поздний возврат после no-show.
Polling не запускает второй запрос поверх незавершённого и не перезаписывает результат
действия устаревшим ответом; новые заявки подтягиваются вместе с очередной версией плана.

Диспетчерский нижний маршрут строится по тому же `projectLiveGraph`, что карта:
начало смены, заявки и обед; ожидания окон не являются вершинами. История из `history`
сохраняет завершённые/отменённые визиты после пересчёта, `breaks` добавляет технические
отметки. Выход на смену окрашивает старт зелёным, движение выделяет ребро и позицию,
визит — текущую вершину. Дата и время в рабочих экранах берутся из логических часов.
Алёрты сохраняются во вкладке «Алерты»; ручное разрешение не добавлено в этом проходе.
Каждый инженер получает `routeState` (`active`, `awaiting_plan`, `exhausted`), свои
`stats` и фактический `progress`. У `progress` есть фаза, неизменяемая точка начала дня
`origin`, последняя достигнутая точка `anchor`, следующая точка `next` и опциональная
точка `lunch`. `lunch` задаёт составной путь `anchor → lunch → next` до начала следующей
заявки. Карта и пайплайн строят активные вершины и рёбра из одной проекции этих полей,
не показывают `wait` отдельной вершиной и не используют синтетический `route.start`.
Фактическая точка `progress.lunch` заменяет плановую точку обеда вместе со временем,
а не добавляется к ней. Совпадение координат обеда и заявки не переносит маркер
между адресами: карта всегда сохраняет географическое положение из данных.
Обе карты (диспетчер и детали заявки инженера) используют онлайн-подложку улиц с
локальным резервом. Единичная ошибка тайла не переключает уже загруженную карту
в офлайн; начальной загрузке даётся 15 секунд. Событие отсутствия сети включает
локальную подложку, восстановление сети возвращает онлайн-карту.
В деталях заявки действия прижаты вниз доступного экрана, кнопка навигации овальная.
Успешное начало/окончание техперерыва не выводит текстовое уведомление в списке заявок.
В списке и меню инженера фактический интервал `lunch` / `engineer.lunchInterval`
приоритетнее старой плановой остановки; после окончания фактического обеда
устаревший плановый интервал повторно не показывается.
Элемент истории содержит `terminalAt`; сортировка завершённых и отменённых заявок
выполняется по этому фактическому времени.

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

Модалка «Настройки» пишет сразу два контура: пороги Router — сюда, часы дня /
alert-таймеры / ключи карт — в `/dispatch/settings`.

**GET `/dispatch/settings`** →

```json
{
  "dayStartMin": 540, "dayEndMin": 1260,
  "noShowSec": 1800, "overdueSec": 300, "timeRiskSec": 300, "repeatAfterSec": 900,
  "twogisApiKeySet": true, "twogisApiKeyLast4": "ab12",
  "yandexApiKeySet": false, "yandexApiKeyLast4": null
}
```

Минуты — от полуночи Москвы. Секреты карт никогда не возвращаются, только наличие
и последние 4 символа.

**PUT `/dispatch/settings`** — `{operationId, dayStartMin?, dayEndMin?, noShowSec?,
overdueSec?, timeRiskSec?, repeatAfterSec?, twogisApiKey?, yandexApiKey?}` → тот же
вид, что GET. Опущенное поле не меняется; `null` или пустая строка на ключе карты
снимает его. Смена `dayStartMin`/`dayEndMin` переписывает смену сегодняшних
`EngineerDay`, у которых ещё нет линии.

**GET `/dispatch/settings/maps/status`** → `{active: "twogis"|"yandex"|"none",
twogis: {provider, configured, ok, message}, yandex: {…}}`. Проба идёт параллельно;
если отвечают оба — `active=twogis`.

**GET `/dispatch/geocode?q=`** или `?city=&street=` → `{hits: [{displayName, lat, lon}]}`.
Сервер зовёт LocationIQ **autocomplete** (`/v1/autocomplete`) с одним `q` — так
находятся криво набранные адреса. `city`+`street` склеиваются в `q`, если его нет.
Без `LOCATION_IQ_TOKEN` — `NOT_CONFIGURED`; точку тогда задают кликом по карте.

Новая заявка с `lat`/`lon` получает `region` ближайшего геоцентра уже существующих
заявок этого региона. Если у региона ещё нет точек — геоцентр считают по домам
инженеров, затем по депо.

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

Нога маршрута (`routes[].legs[]`) несёт `travelSource`
(`approximate` | `road_matrix` | `route_api` | `traffic_api`) и, если sys подменил
геометрию ответом карт, `geometryProvider: "twogis"|"yandex"`. Карта рисует геоцентры
пунктиром цвета инженера, OSRM — серой сплошной, 2ГИС/Яндекс — зелёной сплошной
(`#16A34A`). Без ключей карт план остаётся с геометрией Router; золотой план не
меняется.

**POST `/dispatch/mode`** — `{operationId, mode: "auto"|"manual", expectedModeVersion, expectedPlanRevision, reason?}` → `{control}`. Для MANUAL обязательна непустая причина; версия `0` означает отсутствие первого плана. В MANUAL автоматические результаты не применяются.

Новый диспетчерский фронтенд (`apps/frontend`) запрашивает причину перед переходом
в MANUAL, берёт обе версии из `GET /dispatch/plan` и после успешной операции перечитывает
план. При `VERSION_CONFLICT` он показывает причину отказа и обновляет состояние;
повторная правка требует нового действия диспетчера. Возврат в AUTO отправляет те же
версии без причины. В карточке заявки MANUAL-переназначение и кнопки изменения порядка
также передают версии; порядок содержит все ещё не начатые заявки бригады.
Кнопка начала подготовленного LIVE-дня вызывает `POST /dispatch/live/start`, после
чего перечитываются состояние дня, заявки и план.

**POST `/dispatch/plan/reassign`** — `{operationId, requestId, engineerId, expectedModeVersion, expectedPlanRevision}` — перенос неначатой работы (ручной режим).

**POST `/dispatch/plan/reorder`** — `{operationId, engineerId, requestIds: [...], expectedModeVersion, expectedPlanRevision}` — полный порядок редактируемой части очереди без повторов. Защищённые и нерабочие остановки сохраняют места.

**POST `/dispatch/plan/manual-preview`** — payload соответствующей операции плюс `kind`;
проверка без записи. **GET `/dispatch/plan/manual-history`** — постоянный журнал последних
100 переходов и правок. Подробности и набор 4/2: [MANUAL](manual-control.md).
`routes[].timingStatus: "unverified"` запрещает показывать скопированные времена и
метрики как новый расчёт. Дашборд продолжает читать рабочий план при недоступном Router;
в этом случае `snapshot.routerSettings` может быть `null`.

При подключённых картах `timingStatus: "forecast"` разрешает показывать новый ETA
даже для MANUAL: меняется прогноз времени, а не порядок/назначения. `mapForecast`
указывает свежесть, смешанный источник и риски окон/смены; `legs[].mapObservation`
содержит время наблюдения и режим пробок. Эти поля читаются одинаково в API
диспетчера и инженера. Детали — [прогноз карт](api.md#прогноз-карт-поверх-рабочего-плана-dro-101).
Сохранение вкладки «Карты» не меняет настройки Router и не запускает оптимизацию;
после сохранения обновляется текущий прогноз. Диагностика показывает счётчик запросов
текущего процесса, а общий остаток квоты проверяется в кабинете 2ГИС.

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
| `{operationId, kind: "demo", confirmation: "reset to test data"}` | Сброс к тестовому набору. На `DEMO_STAND` это тот же rewind, что `restart-demo` |
| `{operationId, kind: "empty", confirmation: "erase all application data"}` | Полный сброс «всё в ноль» |

Без точной фразы подтверждения — отказ. Обычный `empty` сбрасывает и сессии.
На публичном стенде `kind: "demo"` сохраняет сессию диспетчера и заново сеет 14/2.

**POST `/dispatch/data/restart-demo`** — только при `DEMO_STAND=true`, только сессия
диспетчера: `{operationId}` → `{restored, workDate, requestsCreated, engineersCreated, generation}`.
Иначе `NOT_FOUND`. Живой день (`running`) кнопка всё равно перематывает; автосдвиг даты
running-день не трогает. `GET /dispatch/live` и `GET /dispatch/data/state` отдают
`demoStand: true` на этом контуре.

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
| POST | `/engineer/email-change` | `{email}` → `{email, expiresAt, devCode?}` — код на **новый** адрес; текущий логин не меняется, пока код не подтверждён. Занятый адрес — `VALIDATION_FAILED` |
| POST | `/engineer/email-change/confirm` | `{email, code}` → `{engineer}` — переносит логин на подтверждённый адрес |
| GET | `/engineer/day` | → `{day: EngineerDayView}` |
| POST | `/engineer/availability` | `{operationId, availability, expectedOnlineAt?}` → `{day}` |
| POST | `/engineer/technical-break` | `{operationId}` → `{day}` |
| POST | `/engineer/lunch/start` · `/finish` | `{operationId}` → `{day}` |
| GET | `/engineer/plan` | → `{planAsOf, origin, revision, route: PlanRouteView|null, requests: RequestView[]}` — свой маршрут применённого плана и карточки заявок этого маршрута |
| GET | `/engineer/requests/:id` | → `{request: RequestView, stop: PlanStopView}` — только если заявка стоит в применённом маршруте этого инженера; иначе `NOT_FOUND` |
| POST | `/engineer/requests/:id/facts` | `{operationId, kind: "arrived"\|"arrived_blocked"\|"started"\|"finished"\|"problem", occurredAt?, note?}` → факт исполнения; отмечать можно только то, что назначено применённым планом; финиш без старта — 422 |

SPA `/engineer/` (вход по коду, список заявок и обеда, карточка/карта точки, маршрут на день, настройки имени/транспорта/почты) живёт в том же `apps/web`, что и дашборд. Почту бригаде без логина задаёт диспетчер через `POST /dispatch/engineers/link-account` на вкладке «Инженеры»; снять её можно через `unlink-account`. Вход только живой сессией по коду, без локального обхода.

## 8. Контур клиента `/api/v1/client/...` (роль `client`)

`GET /client/work-types` → `{workTypes: [{code, title}]}` — каталог типов работ (выбор
в форме; код = ключ для `POST .../requests {workType}`). `POST /client/requests`
(черновик) → `POST /client/requests/:id/submit` (подтверждение) → заявка становится
задачей; `POST /client/requests/:id/reschedule`; `POST /client/requests/:id/cancel`
(`{operationId, expectedVersion?, reason?}` → `{request}`) — отмена своей неначатой
заявки; `GET /client/requests`, `GET /client/requests/:id` — только свои заявки.
Тела — как §6.1 минус `clientEmail`.

`PATCH /client/notifications` — `{operationId, enabled}` → `{enabled}`: выключает
событийные письма адреса (каталог писем — `docs/api.md` §5); коды входа приходят
всегда. Кнопки из писем («Выбрать новое время» / «Отменить заявку») ведут в карточку
заявки (`/client/requests/:id`, отмена — с `?action=cancel`) и выполняются живой
сессией заказчика.

## 9. AI-контур `/api/v1/ai/...` (роли `client`/`engineer`/`dispatcher`)

Полное поведение подсистемы: [ai.md](./ai.md). Здесь — только то, что нужно, чтобы
написать клиент: транспорт, контракт события и конкретные тела запросов.

### 9.1 Поток событий читайте `fetch` + `ReadableStream`, не `EventSource`

`GET /ai/runs/:runId/events?afterSeq=` — Server-Sent Events, но подключайтесь к нему
через `fetch(url, {headers: {authorization: 'Bearer <token>'}})` и
`response.body.getReader()` (готовая реализация — `streamAssistantRun` в
`apps/web/src/api/ai.ts`), **никогда** через `EventSource`. Причина не стилистическая:
`EventSource` физически не может отправить заголовок `Authorization`, а этот проект
запрещает класть bearer-токен в URL (он тогда осел бы в истории браузера, логах прокси
и заголовке `Referer` любого следующего запроса страницы). `fetch`-стриминг — единственный
транспорт, который одновременно удовлетворяет модели авторизации и этому правилу; не
«упрощайте» обратно на `EventSource` — это молча вернёт нешифрованный, неаутентифицированный поток.

Кадры разделены пустой строкой (`\r?\n\r?\n`), как того требует формат SSE; строки
`data:` внутри кадра склеиваются в один JSON. Комментарии/heartbeat-кадры (`: ping`)
не несут `data:` и должны быть проигнорированы, не поданы в парсер. Разбор
незавершённого кадра, пришедшего разрезанным по границе чанка, откладывается до
следующего чтения — не пытайтесь распарсить частичный остаток.

### 9.2 `?afterSeq=` — правило возобновления

И `GET /ai/runs/:runId/events`, и `GET /ai/conversations/:id/messages` принимают
`afterSeq` (по умолчанию 0) и отдают строго то, что пришло после него — `seq` назначает
сервер, строго растёт внутри своей последовательности (запуска — для событий, диалога —
для сообщений), и это единственный курсор, который обязан хранить клиент. Перезагрузка
страницы посреди генерации — обычное возобновление с последнего увиденного `seq`, а не
потерянный ответ. Одно исключение из «читайте всё, что дошло»: `message_delta`
никогда не персистится и не переигрывается после разрыва — после реконнекта вы получите
уже готовое `message` этой реплики плюс живые дельты со следующей, но не дорисуете
частичный текст, который не можете доказать.

### 9.3 Объединение событий запуска

Ровно то же объединение `AiRunEvent`, что в `runtime/ai-event.types.ts` на сервере,
зеркалится в `apps/web/src/api/ai.ts` как `aiRunEventSchema` (Zod, `discriminatedUnion`
по `type`):

| `type` | Персистится | Несёт |
|---|---|---|
| `run_started` | да | `runId`, `conversationId` |
| `message_delta` | **нет** | потоковый фрагмент текста (`messageId`, `text`) |
| `message` | да | готовая реплика: `kind`, `text`, `actions[]` (см. §9.5) |
| `tool_started` / `tool_result` | да | `toolName` + человекочитаемое намерение / безопасная сводка результата |
| `operation_prepared` / `operation_state` | да | карточка подготовлена / сменила состояние (см. §9.6) |
| `help_requested` / `mode_changed` | да | диалог передан диспетчеру / сменил режим `ai`↔`dispatcher` |
| `quota` | да | `remainingMicros`, `remainingMessages`, `resetAt` |
| `stopped` | да | `reason`: `user`/`handover`/`budget`/`shutdown` |
| `error` | да | `code`, `message` — терминальный отказ отрендерен как событие, не как HTTP-ошибка (поток обязан никогда не ошибаться после того, как заголовки SSE уже отправлены) |
| `run_finished` | да | `state`, `usage` — конец запуска, можно закрывать соединение (`isTerminalAiEvent`) |

Только `message` несёт одну из четырёх согласованных визуальных форм (`kind`):
`text`, `text_action`, `text_action_cancel`, `text_confirmation`. Остальные типы —
системные; не расширяйте словарь, который может отрендерить модель, добавлением новых
`kind` без изменения контракта на обеих сторонах.

### 9.4 Поток человек↔человек: `GET /ai/conversations/:id/events` и `GET /dispatch/chats/events`

Два SSE-эндпоинта несут переписку двух людей, а не генерацию модели, и делают это тем
же транспортом, что §9.1 описывает для запуска: `fetch` + `ReadableStream`, **никогда**
`EventSource` — `EventSource` не умеет отправить заголовок `Authorization`, а класть
bearer-токен в URL здесь запрещено тем же правилом, что и для `runs/:runId/events`. То
же правило возобновления `?afterSeq=` (§9.2) тоже действует, но союз событий свой,
отдельный от `AiRunEvent` (`chat-stream.ts`):

```ts
{ type: 'message'; at: number; conversationId: string; message: AiMessage }
| { type: 'state'; at: number; conversationId: string; mode: string; handoff: AiHandoff | null }
```

- `message.seq` — тот же курсор, что в §9.2: единственное состояние, которое хранит
  клиент, растёт внутри диалога и назначается сервером. Сообщение публикуется только
  после коммита писавшей его транзакции, поэтому его можно отрендерить сразу по
  получении, не перечитывая для проверки.
- `state` несёт не переход, а положение целиком (`mode` диалога плюс весь `handoff` или
  `null`) — доставленный дважды или пропущенный между реконнектами (следующий
  `?afterSeq=` всё равно принесёт актуальный `mode`) не искажает картину; в отличие от
  `message`, его не нужно дедуплицировать по `seq`.
- Нет `message_delta` и нет терминального события вроде `run_finished`: у разговора двух
  людей нет ни эфемерной середины, ни конца, который стрим обязан объявить — соединение
  просто живёт, как обычное SSE-соединение, до разрыва (обоснование дословно в `29`
  D-37).
- Heartbeat-кадры идут тем же `AI_SSE_HEARTBEAT_MS`, что у `runs/:runId/events`.

**`GET /ai/conversations/:id/events?afterSeq=`** — один диалог, только его владелец (та
же проверка, что у `GET .../messages`). При подключении отдаёт пропущенное после
`afterSeq` (сообщения, затем текущее состояние последним), потом переходит на живой
поток — той же техникой «подписка открывается раньше чтения хвоста», что у
`runs/:runId/events` (§9.1), так что сообщение, записанное в зазор между ними, не
теряется.

**`GET /dispatch/chats/events`** — только диспетчер, сразу все диалоги, которые у
человека на руках сейчас (`handoffId !== null`). У этого потока **нет** реплея: догнать
пропущенное — обычный `GET /dispatch/chats` (§9.8), который и так отдаёт каждую строку
с уже посчитанным `unreadCount`; переигрывать курсор по каждому из десятков диалогов
сразу означало бы держать на клиенте курсор на чат, которого он ещё не открывал, и всё
равно перечитывать список для остальных. Читатель этого потока обязан хранить последний
увиденный `seq` **на каждый `conversationId` отдельно** — `seq` растёт внутри одного
диалога, а не по списку целиком, поэтому общий счётчик на весь список молча потерял бы
сообщения диалога, который просто пишет реже соседнего.

### 9.5 Кнопки действий никогда не собирают payload на клиенте

`AiActionButton.kind`: `confirm_operation` / `cancel_operation` / `open_object`.
`operationId` адресует уже провалидированную сервером подготовленную операцию — клиент
отправляет его обратно для подтверждения/отмены и никогда сам не собирает бизнес-тело
запроса. `target` (только для `open_object`) — что должен выбрать дашборд
(`{type: 'request'|'engineer'|'alert', id}`), никогда URL от модели.

### 9.6 Состояния операции — `outcome_unknown` не значит «отменено»

`AiOperationState`: `prepared` → `awaiting_confirmation` → `running` → одно из
`applied` / `rejected` / `cancelled_before_apply` / `outcome_unknown`.

`cancelled_before_apply` и `outcome_unknown` — не синонимы и не варианты одного и того
же «ничего не случилось»:

- `cancelled_before_apply` — карточку **отменили до применения** (кнопка «Отменить»,
  либо истёк срок `expiresAt` без ответа человека). Записи точно не было.
- `outcome_unknown` — запись **могла применённой, а могла и нет**: сбой произошёл после
  вызова `OperationsService.execute`, но до того, как сервер получил подтверждённый
  ответ. Показывайте это состояние как честную неопределённость (например, «не удалось
  подтвердить исход — проверьте объект напрямую»), никогда не как «отменено» и никогда
  как «выполнено» — обе интерпретации были бы догадкой, а не прочитанным фактом.

Остановка запуска (`stopped`) никогда сама по себе не переводит уже применённую карточку
обратно — если запись случилась, откат — отдельная, обычная разрешённая бизнес-операция,
а не побочный эффект нажатия «Остановить».

### 9.7 Диалог, сообщение, поток — конкретные тела

**POST `/ai/conversations`** — `{contextRef?, assistMode?}` → `{conversation}`.
Возвращает существующий открытый диалог своей роли+ланы или создаёт новый.
`assistMode` (`help`/`fix`) значим только для диспетчера и переключает durable
общесистемный флаг (`ai.md` §5.1), а не разовое поле этого диалога; для клиента и
инженера игнорируется.

**GET `/ai/conversations/:id/messages?afterSeq=`** → `{messages: AiMessage[]}` — тот же
курсор постраничного чтения, что и в §9.2.

**POST `/ai/conversations/:id/messages`** — конверт операций (§4) плюс `{text}` →
`{runId, messageSeq, handedOver, quota?}`. `handedOver: true` и `runId: null` означают:
диалог уже передан человеку-диспетчеру (`conversation.mode === 'dispatcher'`) — запуск
не стартует, квота не тратится, ответа от AI не будет, пока диспетчер не завершит
передачу. Иначе слушайте `GET /ai/runs/:runId/events`.

**POST `/ai/runs/:runId/stop`** — `{operationId}` → `{stopped: true}`. Запуск всё равно
закончится штатным `stopped`-событием в потоке (§9.3), а не мгновенно обрубится на этом
ответе.

**POST `/ai/operations/:id/apply`** / **`.../cancel`** — `{operationId}` →
`OperationOutcomeView` (`{aiOperationId, state, result?, error?}`, §9.6). Определяющее
состояние всё равно приходит как `operation_state` в потоке запуска, который подготовил
карточку — ответ на `apply`/`cancel` можно использовать для мгновенного UI-отклика, но
не как единственный источник истины, если поток ещё открыт.

Explain-агент (`POST /ai/explain`) и предложение по алерту (`POST
/ai/alerts/:id/suggest`) — отдельные, дополняющие эндпоинты; их тела и правила отказа
описаны в «Дополнение 20.09.2026» ниже и в [ai.md](./ai.md) §5.2.

### 9.8 `/dispatch/chats*` — диспетчерская сторона DF-19

Только для роли `dispatcher` (`@Roles('dispatcher')`, как весь остальной `/dispatch`).
Открытие вкладки — обычное чтение и ничего не меняет (context/36 §9.1). Живая доставка
этого же контура — §9.4.

**GET `/dispatch/chats?closedLimit=`** → `{chats: DispatchChatView[]}` — сперва живые
передачи (диалог сейчас в режиме `dispatcher`), отсортированные по последней реплике,
затем до `closedLimit` (по умолчанию 30, максимум 200) уже завершённых, отсортированных
по времени закрытия. Завершённые остаются в списке навсегда, а не пропадают в момент
завершения (context/36 §9.3) — только их число на одной странице ограничено. Каждая
строка —

```json
{
  "handoff": {
    "id": "...", "conversationId": "...",
    "requestedByAccountId": "...", "actorRole": "client"|"engineer",
    "initiatedBy": "user"|"dispatcher",
    "requestIds": ["..."], "engineerIds": ["..."],
    "state": "waiting"|"answered"|"closed",
    "startSeq": 0, "endSeq": null,
    "createdAt": 0, "firstReplyAt": null, "closedAt": null
  },
  "conversation": AiConversation,
  "messages": AiMessage[],
  "unreadCount": 0
}
```

`initiatedBy` называет способ, которым чат начался: `user` — ассистент вызвал
`call_dispatch_helper`, `dispatcher` — диспетчер сам открыл его кнопкой «Написать»
(`POST /dispatch/chats` ниже); `actorRole` — всегда роль **собеседника** (`client` или
`engineer`), никогда `dispatcher`, в обоих случаях. `startSeq`/`endSeq` — границы
эпизода внутри диалога: живой эпизод показывает `messages` от `startSeq` до конца
диалога (вся история человека, включая сказанное ассистенту до передачи), завершённый —
обрезанные ровно по `endSeq`, то есть диалог таким, каким он был на момент завершения, а
не подрастающим задним числом (§9.3 модели). `unreadCount` — уже посчитанное сервером
число сообщений собеседника после внутреннего курсора прочтения (`AiHandoff.
dispatcherLastReadSeq`, сам курсор в `DispatchChatView` не отдаётся); у закрытой строки
всегда 0 — делать с ней больше нечего.

Ожидание/ответ читайте по `handoff.state`/`handoff.firstReplyAt`, **не** по
`conversation.mode`: у живой передачи `mode` всегда `dispatcher` и само по себе не
отличает «ждём» от «ответили» (context/38 §7.4 — до первого ответа это честное ожидание,
никогда ложное «оператор подключён»), а у закрытой строки `mode` уже вернулся в `ai`,
хотя строка никуда не делась. `state` — единственное поле, которое действительно живое:
оно возвращается в `waiting`, стоит собеседнику написать снова без ответа диспетчера
следом, тогда как `firstReplyAt` проставляется один раз и не переписывается.

**POST `/dispatch/chats`** — `{operationId, target, text?}` → `{chat: DispatchChatView}`.
Второй способ, которым чат начинается — первый см. выше (`initiatedBy: 'user'`). `target`
— `{kind: 'request', requestId}` или `{kind: 'engineer', engineerId}`: сервер сам находит
аккаунт клиента заявки или аккаунт инженера, браузеру не нужно и не должно знать чужой
`accountId`. `text` необязателен — открыть чат, чтобы сначала прочитать историю, а
написать позже, это нормально. Повторное нажатие, пока чат уже открыт, не заводит вторую
строку и не ошибка — возвращает ту же самую. Отвечает `409 CHAT_TARGET_UNREACHABLE`,
если у заявки нет аккаунта заказчика или у инженера нет логина в приложении — объект
существует, писать ему просто некуда, и это осознанно не `404`, которое диспетчер читал
бы как баг.

**POST `/dispatch/chats/:id/messages`** — `{operationId, text}` →
`{message: AiMessage, chat: DispatchChatView}`. `:id` — id диалога (`conversation.id`,
тот же, что в `DispatchChatView.conversation.id`). Ответ сохраняется с
`author: "dispatcher"` и заполненным `authorAccountId`; run не стартует и квота не
тратится. Первый такой ответ переводит связанный `AiHandoff` из `waiting` в `answered` и
проставляет `firstReplyAt`; повторный ответ это не двигает, но всё равно двигает
`dispatcherLastReadSeq` — ответ и есть подтверждение прочтения, отдельного вызова не
нужно.

**POST `/dispatch/chats/:id/finish`** — `{operationId}` →
`{conversation: AiConversation, chat: DispatchChatView}` (`conversation.mode` снова
`"ai"`, `chat.handoff.state === "closed"`, `chat.handoff.endSeq` заполнен). История и уже
применённые действия не удаляются и не откатываются (context/36 §9.3); строка остаётся в
`GET /dispatch/chats` как закрытая, а не исчезает.

**POST `/dispatch/chats/:id/read`** — `{operationId, seq}` → `{chat: DispatchChatView |
null}`. Двигает внутренний курсор прочтения вперёд, никогда назад — повтор старого
значения из отставшей вкладки не может вернуть уже снятый бейдж непрочитанного; итог
виден в пересчитанном `unreadCount` возвращённого `chat`. `chat: null`, когда для
диалога сейчас нет открытого `AiHandoff` — это не ошибка, снимать уже нечего.

`.../messages` и `.../finish` (но не `POST /dispatch/chats`, который сам открывает
передачу при необходимости, и не `.../read`, для которого нет открытого `AiHandoff` —
честный no-op) отвечают `409 AI_HANDOFF_NOT_ACTIVE`, если для диалога сейчас нет
открытого `AiHandoff` — диалог никогда не передавался диспетчеру, либо передача уже
завершена. Это осознанно один и тот же код на оба случая: поздний ответ диспетчера из
уже закрытой вкладки не должен молча переоткрыть передачу (context/36 §9.4) — клиент
просто перечитывает `GET /dispatch/chats`.

## 10. Health (вне `/api/v1`, без авторизации)

`GET /health/live` → процесс жив. `GET /health/ready` → 503, если недоступна БД.
`GET /health/services` → `{services: {postgres, router, ai, smtp: {status: "up"|"not_configured"|"down"}}}` — используйте, чтобы честно показать состояние контура.

## 11. Объяснения: причины назначений

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

## 12. Типовой поток дашборда

1. `POST /auth/login-code` + `verify` с `role: "dispatcher"` (или запасной
   `POST /auth/dispatcher/password`) → токен; `GET /health/services` — баннер состояния.
2. `GET /dispatch/data/state` → если `initialized: false` — экран импорта
   (`POST /dispatch/data/import {regions:"all"}`).
3. `GET /dispatch/requests` + `GET /dispatch/engineers` + `GET /dispatch/plan` — день.
4. `GET /dispatch/alerts`; неназначенные — из `plan.assignments` (`status: "unassigned"`)
   с причинами из §11.
5. Действия: выбор политики, технастройки, перенос/перестановка (MANUAL), создание/
   правка заявок, отключение инженера — каждый вызов с новым `operationId`.
6. Обновление: polling `GET /dispatch/plan` (+ `requests`, `alerts`) — SSE пока нет.
7. Сравнение политик: `GET /dispatch/policy-comparison` по кнопке (тяжёлый, до 90 с
   на холодном снимке), 409 — перечитать; 503 во время rebuild — повторить.

## 13. Что важно не сломать

- Время — только целые секунды; таймзона — только на рендере.
- `operationId` на каждое намерение; ретрай — тем же id.
- Три состояния заявки (`lifecycle`, `assignmentState`, факты) не смешивать.
- `pending` — «ждёт расчёта», не ошибка и не «не назначена».
- Координаты не выдумывать: пустые — это диагностика, а не повод поставить точку.
- Объяснения — только из `reasons` по кодам; никаких собственных «объяснений алгоритма».

## Настройки и показатели сравнения (18.09.2026)

Техническая ревизия Router содержит `windowLatenessToleranceSec` (0…1200 секунд, продуктовый default 600), `trafficEnabled` и `equipmentEnabled` (default true); Python использует snake_case. Передача — через существующие endpoint технических настроек и CAS contextVersion. Предыдущие поля обязательны и сохраняются. Окно клиента остаётся исходным; допуск ограничивает нормативное завершение после закрытия окна и отличается от допусков revalidation.

Метрики сравнения дополнены `lateAssignedCount`, `totalLatenessSec`, `minWindowSlackSec` (null без назначений), `workloadSpreadSec`, `maxWorkloadSec`. Отсутствующие поля старых записей читаются с defaults 0/null; такие записи не доказывают измерение новых показателей. Полный смысл и формулы — `docs/solver.md`, сверочные значения — `docs/policy-efficiency.md`.


## Дополнение 18.09.2026: сравнение с расширяемым составом

«Полное покрытие» (`covering-2`) включено отдельной седьмой строкой.
Количество дополнительных исполнителей передаётся в `additional_engineers`
(`additionalEngineers` в веб/API). Её маршруты не доступны остальным политикам
и FIFO. Клиент читает старые шестистрочные записи без миграции. Полное покрытие
не отменяет окна, смены, доступность дорог и оборудование; невозможные назначения
сохраняются как unassigned. Замеры и ограничения: `docs/policy-efficiency.md`.

## Дополнение 20.09.2026: evidence, explain-агент и предложения по алертам

Реализован контракт из §11: `GET /dispatch/requests/:id/evidence` (см. §6.1)
и два диспетчерских AI-эндпоинта, дополняющих §9. Оба — только для роли `dispatcher`; сценарий `client`
у explain-агента отсутствует намеренно: честное объяснение требует состава смены
(кто ещё был свободен, у кого был навык), а это заказчику не показывают.

**POST `/ai/explain`** — `{scope, requestId?, engineerId?, alertId?, policyId?, question?}`
→ `{runId}`. `scope`: `request` (назначена/не назначена), `engineer` (маршрут или
простой), `route` (порядок маршрута), `alert`, `policy` (сравнение политик),
`degraded` (оценка ручного плана). Ответ — обычный запуск ассистента: слушайте
`GET /ai/runs/:runId/events` (SSE) так же, как для обычного чата. Один шаг, без
инструментов, температура 0 — первая реплика уже содержит детерминированное объяснение
(`facts → influence → result`, тот же порядок, что и в `apps/web/src/lib/explanations.ts`)
плюс `reasons`/`basis` и `evidence.candidates[]`/`blockers[]` из §6.1/§11; модель только
переформулирует эти данные, не считает и не изобретает ничего своего (AGENTS.md §9.5,
D-11, D-3).

**POST `/ai/alerts/:id/suggest`** — `{operationId}` →
`{proposal, aiOperationId}` или `{refused: true, why}`. `proposal` — провалидированное
предложение: `action` (только из конечного каталога `alertActionsFor(alert.code)`),
опционально `minutes`, `windowDate`/`windowStartLocal`/`windowEndLocal` (локальные дата и
время, не эпоха), `engineerId` (только из вычисленного сервером списка кандидатов на
`add_engineer` — офлайн, подходящий навык и регион), `reason`, `confidence`,
`rejected[]` (до трёх других вариантов и почему их не выбрали). Отказ (`refused: true`)
означает: ответ модели не прошёл валидацию каталога/кандидатов, либо прошёл, но не
выполнил реальное условие `alerts.service.ts#applyAction` (например, `move_window` без
упорядоченных границ, `add_engineer` без провалидированного `engineerId`,
`shift_no_show`-`extend` не на 15 минут, `restore_auto` без `restoreOption`). Повторного
запроса модели при отказе нет — отказ отдаётся диспетчеру как есть. При успехе
предложение уже подготовлено как операция `alert.resolve` (`aiOperationId`) — подтверждение
идёт тем же путём, что и `POST /ai/operations/:id/apply` для любой другой карточки.
