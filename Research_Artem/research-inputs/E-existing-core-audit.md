# E. Аудит существующего ядра `core/`

Дата аудита: 2026-09-15. Область: `core/**`, `docs/solver.md`, `docs/mcp-kanban.md`. Папка `context/` не читалась.
Все ссылки — `файл:строка` в рабочей копии.

## 0. Состав и объём

| Файл | Строк | Роль |
|---|---|---|
| `core/types.py` | 342 | Контракты JSON (SolverInput / PlanSolution), парс "HH:MM" ↔ минуты |
| `core/matrix.py` | 119 | Матрица времени в пути (haversine + коэффициент часа) |
| `core/model.py` | 381 | Префильтр совместимости + модель OR-Tools Routing + извлечение маршрутов |
| `core/reasons.py` | 228 | Правиловые объяснения (факторы, альтернативы, причины неназначения) |
| `core/metrics.py` | 99 | Метрики плана |
| `core/gen.py` | 280 | Сид-генератор синтетических датасетов (`mini`, `full`) |
| `core/solve.py` | 107 | `solve_task()` + CLI `python -m core.solve` |
| `core/studio.py` | 297 | FastAPI-дев-UI (карта, перепланирование) |
| `core/studio.html` | 599 | SPA на MapLibre GL |
| `core/tests/*` | 7 файлов | 30+ тестов, включая golden-гейт |
| `core/tests/golden/` | 2 файла | `mini_input.json` + `mini_solution.json` |

Зависимости (`core/requirements.txt`): `ortools==9.15.*`, `pytest>=8.0`, `ruff>=0.8`, `fastapi>=0.115`,
`uvicorn>=0.30`, `httpx>=0.27`. **Ни pandas, ни geopy, ни OSRM-клиента нет.**

---

## 1. Модель данных (`core/types.py`)

### Сущности и поля (имена уже зафиксированы — не придумывать конфликтующие)

| Класс | Строка | Поля (точные имена) |
|---|---|---|
| `LatLon` | `core/types.py:56` | `lat: float`, `lon: float` (WGS84, десятичные градусы) |
| `Engineer` | `core/types.py:64` | `id: str`, `start: LatLon`, `end: LatLon\|None`, `shift_start_min: int`, `shift_end_min: int`, `skills: tuple[str,...]`, `vehicle_class: str`, `equipment: tuple[str,...]`; свойство `end_point` (`:82`) — при `end=None` возврат в `start` |
| `Request` | `core/types.py:88` | `id`, `lat`, `lon`, `window_open_min`, `window_close_min`, `window_strict: bool`, `service_min: int`, `required_skills: tuple[str,...]`, `required_equipment: dict[str,int]`, `allowed_vehicle_classes: tuple[str,...]`, `priority: str`; свойство `hard_window` (`:110`) = `window_strict or priority == "vip"` |
| `TravelMatrixSpec` | `core/types.py:116` | `src: str`, `resolution: str`, `hour_coeff: dict[int,float]` |
| `FixEntry` | `core/types.py:130` | `engineer: str`, `seq_before: int\|None` — **парсится, но НЕ применяется** |
| `SolverInput` | `core/types.py:142` | `date: str`, `engineers`, `requests`, `travel_matrix`, `weights: dict[str,int]`, `fix: dict[str,FixEntry]` |
| `Assignment` | `core/types.py:154` | `request`, `engineer`, `seq: int`, `eta_min`, `done_by_min`, `travel_from_prev_min`, `wait_min` |
| `Unassigned` | `core/types.py:175` | `request: str`, `why: str` |
| `Metrics` | `core/types.py:183` | см. §5 |
| `PlanSolution` | `core/types.py:211` | `assignments`, `unassigned`, `metrics`, `solve_ms: int`, `reasons: dict[str, dict]` |

### Единицы измерения (жёсткая конвенция)

- В JSON: время как строки `"HH:MM"` (`parse_hhmm` `core/types.py:20`, `format_hhmm` `:42`). Часы > 23
  и минуты > 59 отвергаются → **смены через полночь не поддерживаются**.
- В dataclass: целые **минуты от полуночи** локального времени города.
- Внутри OR-Tools: целые **секунды** (`core/model.py:203`, `:232`).
- Таймзон нет нигде.
- Расстояния — км (внутри `matrix.py`), время в пути — целые минуты (ceil).

### Enum-ов нет — все «перечисления» это свободные строки

| Смысл | Где значения | Фактические значения |
|---|---|---|
| Навык (`skills` / `required_skills`) | `core/gen.py:56-68`, `:86-106` | `fiber`, `network`, `splice`, `video` |
| Транспорт (`vehicle_class`) | `core/gen.py:88-106`, дефолт `core/types.py:242` | `sedan`, `van`, `van_ladder`; дефолт при парсе — `"sedan"` |
| Допустимый транспорт (`allowed_vehicle_classes`) | `core/types.py:261` | `"any"` — wildcard (дефолт), иначе список классов |
| Приоритет (`priority`) | `core/types.py:262` | `"std"` (дефолт), `"vip"` |
| Оборудование | `core/gen.py:59-66` | `onr`, `router_wifi6`, `splice_kit`, `thermal_camera`, `stb` |
| Коды блокировки | `core/reasons.py:32-37` | `skill_missing`, `equipment_missing`, `vehicle_class`, `shift_window` |
| Коды факторов | `core/reasons.py:124-165` | `skill_match`, `equipment_ok`, `sla_margin`, `window_tight`, `travel_delta`, `load_balance` |
| Коды неназначения | `core/reasons.py:55`, `:56` | `no_candidate`, `window_conflict` |

**Дефолты парсера** (`core/types.py:247-263`): `service_min = 60`, `window_strict = False`,
`allowed_vehicle_classes = ("any",)`, `priority = "std"`, `vehicle_class = "sedan"`, `weights = DEFAULT_WEIGHTS`.
`DEFAULT_WEIGHTS = {"sla": 100000, "balance": 500, "travel": 1}` (`core/types.py:17`).

---

## 2. Солвер (`core/model.py`, `core/solve.py`)

### Что за движок

**OR-Tools Routing (pywrapcp), НЕ CP-SAT, НЕ своя эвристика.** Импорт:
`from ortools.constraint_solver import pywrapcp, routing_enums_pb2` (`core/model.py:37`). Модель — мультидепо VRPTW.

- Каждый инженер = отдельный «транспорт» со **своим стартовым и своим конечным депо**
  (`RoutingIndexManager(len(points), n_vehicles, starts, ends)`, `core/model.py:207`). Общего депо нет.
- Узлы: `[0..n)` — старты, `[n..2n)` — концы, `[2n..)` — заявки, отсортированные по `id`
  (`_build_nodes`, `core/model.py:151-157`; сортировка `core/model.py:191` — основа детерминизма).
- Транзит дуги = время в пути + `service` в узле-источнике (`transit_seconds`, `core/model.py:210-213`).
- Измерение `"Time"`: slack (ожидание) ≤ `MAX_WAIT_MIN * 60`, горизонт `HORIZON_MIN * 60`,
  `fix_start_cumul_to_zero=False` (кумулята = абсолютные минуты суток) — `core/model.py:216-222`.

### Реально закодированные ограничения

| Группа | Как реализовано | Тип | Где |
|---|---|---|---|
| Навык (`required_skills ⊆ skills`) | префильтр → `VehicleVar.SetValues` | жёсткое | `core/model.py:125-126`, `:249` |
| Оборудование (с количествами) | префильтр | жёсткое | `_equipment_shortage` `core/model.py:94-96`, `:127` |
| Класс транспорта (`any` — wildcard) | префильтр | жёсткое | `_vehicle_rejected` `core/model.py:99-103`, `:129` |
| Пересечение окна со сменой | префильтр (грубая проверка) | жёсткое | `core/model.py:131-135` |
| Нижняя граница окна | `CumulVar(idx).SetMin(open_sec)` | **всегда жёсткое** | `core/model.py:233` |
| Верхняя граница окна | `SetMax` если `window_strict` или `vip`; иначе `SetCumulVarSoftUpperBound(idx, close_sec, sla_per_sec)` | жёсткое/мягкое | `core/model.py:234-237` |
| Смена инженера | старт зафиксирован `CumulVar(Start(v)).SetValue(shift_start*60)`; возврат `CumulVar(End(v)).SetMax(shift_end*60)` | жёсткое | `core/model.py:251-253` |
| Возможность не назначить | `AddDisjunction([idx], UNASSIGNED_PENALTY)`; если кандидатов нет — `AddDisjunction([idx], 0)` | — | `core/model.py:239-244` |

**Чего в ограничениях НЕТ:** обеденных перерывов, вместимости, переработок, зависимостей между
заявками, приоритетной очерёдности, разных скоростей по классам транспорта, фиксации (`fix` игнорируется).

### Целевая функция и веса

- Стоимость дуги для всех ТС = транзит-колбэк (травел + сервис, в секундах):
  `SetArcCostEvaluatorOfAllVehicles(transit_idx)` (`core/model.py:224`). То есть вес `travel` фактически = 1
  и **параметр `weights["travel"]` в целевой не используется**.
- `UNASSIGNED_PENALTY = 1_000_000` (`core/model.py:44`) — фиксированная константа, из `weights` не берётся.
- Штраф за опоздание: `sla_per_sec = max(1, weights.get("sla", 100000) // 60)` (`core/model.py:227`),
  линейный по секундам сверх `window_close`.
- **`weights["balance"]` (500) нигде в целевой не применяется** — баланс только измеряется в метриках.

| Член | Значение | Механизм |
|---|---|---|
| неназначенная заявка | 1 000 000 | disjunction penalty (0 — если нет ни одного кандидата) |
| опоздание | `weights.sla // 60` за секунду | soft upper bound |
| пробег + сервис | 1 за секунду | arc cost |
| баланс | **не участвует** | — |

### Минимизация числа исполнителей — НЕТ

`SetFixedCostOfVehicle` / `SetFixedCostOfAllVehicles` не вызываются нигде. Пустой маршрут ничего не стоит,
но и «сокращение бригад» никак не поощряется. `balance_std_min` считается по ВСЕМ инженерам,
включая простаивающих (`core/metrics.py:95`).

### Open route (без возврата на базу) — НЕТ

`Engineer.end` может быть `None`, но тогда `end_point` = `start` (`core/types.py:82-85`), т.е. маршрут всегда
замкнут и обратный перегон учитывается в стоимости и в `travel_min_total` (`core/metrics.py:61-63`).
В генераторе все инженеры имеют `"end": None` (`core/gen.py:141`).

### Поиск и детерминизм

- `first_solution_strategy = PARALLEL_CHEAPEST_INSERTION`, `local_search_metaheuristic = GUIDED_LOCAL_SEARCH`
  (`core/model.py:272-273`).
- Дефолтный бюджет `time_limit_ms = 1500` (`core/model.py:162`, `core/solve.py:35`).
- `solution_limit` (опц.) — единственный **гарантированный** детерминированный стоп (в тестах = 100).
- Многопоточность не включается.
- CLI: `python -m core.solve --input plan.json --output solution.json [--time-limit-ms N] [--solution-limit N]`.

### Перепланирование в солвере

`solve(..., previous_routes=...)` → seed через `routing.ReadAssignmentFromRoutes(seed_routes, True)`
(`core/model.py:257-269`), затем `SolveFromAssignmentWithParameters`. Флаг `SolveOutput.warm_started`
(`core/model.py:91`); при нежизнеспособном seed — молчаливый откат на холодный старт.
Штрафа за нестабильность (`w_stab`) нет — только warm start.

---

## 3. Матрица расстояний (`core/matrix.py`)

**Haversine, офлайн. OSRM НЕТ** — только упоминание как будущего drop-in backend.
`travel_matrix.src = "osrm"` молча не обрабатывается: код всегда считает haversine.

| Константа | Значение | Строка |
|---|---|---|
| `BASE_SPEED_KMH` | `28.0` | `core/matrix.py:24` |
| `ROAD_FACTOR` | `1.35` | `core/matrix.py:25` |
| `_PEAK_HOURS` | `{7, 8, 9, 17, 18, 19}` | `core/matrix.py:28` |
| `_NIGHT_HOURS` | `{22, 23, 0, 1, 2, 3, 4, 5, 6}` | `core/matrix.py:29` |
| `PEAK_COEFF` | `1.4` | `core/matrix.py:30` |
| `NIGHT_COEFF` | `0.9` | `core/matrix.py:31` |
| `DEFAULT_COEFF` | `1.0` | `core/matrix.py:32` |
| Радиус Земли | `6371.0088` км | `core/matrix.py:80` |

Формула: `minutes = ceil(dist_km / (BASE_SPEED_KMH / ROAD_FACTOR) * coeff * 60)` (`core/matrix.py:83-94`),
т.е. эффективная скорость **≈ 20.74 км/ч** до применения коэффициента часа.

Ключевое упрощение: **матрица строится один раз на весь солв для ОДНОГО опорного часа** — минимального
`shift_start_min // 60` по всем инженерам (`core/model.py:201-202`). Матрица **симметрична**, диагональ = 0.

---

## 4. Объяснения (`core/reasons.py`)

Всё считается из данных солвера — **никакого LLM и никакого рукописного текста**.
Коды — машиночитаемый английский, `detail`/`why` — русская UI-копия.

Структура для назначенной заявки:

```json
{"assignment": {"chosen": "<eng_id>",
                "factors": [{"code","ok","value","detail"}],
                "alternatives": [{"engineer","blocked","cost_delta","why_not"}]},
 "sequence": [{"swap_with","cost_delta","why"}]}
```

Факторы в фиксированном порядке (`_assignment_factors`, `core/reasons.py:111-166`) с реальными порогами:

| `code` | Критерий `ok` | `value` | Строка |
|---|---|---|---|
| `skill_match` | всегда `True` | список требуемых навыков | `:126-131` |
| `equipment_ok` | всегда `True` | список требуемого оборудования | `:132-140` |
| `sla_margin` | `margin >= 15` мин (`window_close - eta`) | `margin` | `:141-146` |
| `window_tight` | `window_width >= 90` мин | ширина окна | `:147-152` |
| `travel_delta` | всегда `True` | `travel_from_prev_min` | `:153-158` |
| `load_balance` | `abs(workload - mean_load) <= 60` мин | загрузка инженера | `:159-164` |

- `alternatives`: совместимые инженеры по `cost_delta` (минимальная вставка **только по пробегу**),
  затем заблокированные с `why_not`; обрезается до **2** элементов.
- `sequence`: дельты перестановки только с соседями по маршруту, тоже только по пробегу.
- Явное упрощение: дельты игнорируют каскадные эффекты на окна (`core/reasons.py:18-21`).

Коды причин неназначения (`unassigned_why`, `core/reasons.py:40-59`):
- `no_candidate: <label>` — нет ни одного совместимого; label из `BLOCK_LABELS`:
  `нет нужных навыков` / `нет нужного оборудования` / `не подходит транспорт` / `окно вне смены`;
- `window_conflict: есть подходящие инженеры (N), но визит не встроился в окна без нарушения смен`.

Инвариант: `assert len(reasons) == len(requests)` (`core/reasons.py:227`).

---

## 5. Метрики (`core/metrics.py`)

`compute_metrics(input_data, output, previous=None)` (`core/metrics.py:32`). Константа `SHIFTED_ETA_MIN = 5`.

| Поле | Определение | Строка |
|---|---|---|
| `requests_total` / `assigned` / `unassigned` | счётчики | `:45-47`, `:86-88` |
| `sla_ok_pct` | `100 * (total − late_count − unassigned) / total` — **неназначенная считается нарушением SLA** | `:59` |
| `sla_at_risk` | назначенные с `window_close − eta < 15` мин | `:57-58` |
| `late_total_min` | сумма положительных `eta − window_close` | `:53-55` |
| `travel_min_total` | сумма `travel_from_prev` + **обратные перегоны в конечные депо** | `:61-63` |
| `travel_min_mean_per_eng` | `travel_total / len(engineers)` | `:93` |
| `workload_min` | занятый интервал от выезда до возврата; простаивающие = 0 | `:65-70` |
| `balance_std_min` | `pstdev` по ВСЕМ инженерам, включая простаивающих | `:95` |
| `makespan_min` | максимум `span_end − shift_start` | `:71` |
| `wait_min_total` | сумма `wait_min` | `:97` |
| `moves_vs_prev` | `{"reassigned": сменился инженер, "shifted": тот же инженер и \|Δeta\| ≥ 5}` | `:73-83` |

### Бейзлайна НЕТ

Ни модуля, ни функции сравнения с базовым распределением. `moves_vs_prev` — сравнение **с предыдущей
версией того же плана**, а не с бейзлайном. Эталонные числа прогонов (`docs/solver.md:161-167`):
mini (5×10) — 10/10 назначено, SLA 100 %, travel 642 мин, ~180 мс; full (10×80) — 71/80, SLA 88.8 %, бюджет 1.5 с.

Файлы `* Контрольное распределение.csv` с колонкой `Бригада` — естественный источник бейзлайна,
но **кодом не используются**.

---

## 6. Генератор данных (`core/gen.py`)

| Сценарий | Инженеров | Заявок | Назначение |
|---|---|---|---|
| `mini` | 5 (`:100-106`) | 10 (`:111-122`) | заведомо выполнимый; источник golden-плана |
| `full` | 10 (`:86-98`) | 80 (`FULL_COMPOSITION` `:73-82`) | демо с намеренным дефицитом ресурсов |

**География** (`core/gen.py:27-38`): 8 московских якорей `CLUSTERS` — `center (55.7558, 37.6173)`,
`north (55.8780, 37.5460)`, `east (55.7900, 37.8600)`, `southeast (55.7000, 37.8300)`, `south (55.6200, 37.6000)`,
`southwest (55.6500, 37.4800)`, `west (55.7400, 37.3800)`, `northwest (55.8000, 37.4900)`;
`OFFICE = CLUSTERS["center"]`; `FAR_CORNERS = [(55.9200, 37.9500), (55.5500, 37.4500)]`.
`DAY_START_MIN = 9*60`, `DAY_END_MIN = 18*60`. Смена всех инженеров жёстко `["09:00","18:00"]`.

**Распределения:** джиттер координат ±0.003° (офис) / ±0.005° (кластеры) / ±0.02° (заявки);
70 % заявок в случайный кластер, 30 % в центр; окно `std`-заявки — час из
`[9,10,10,11,11,12,13,14,14,15,15,16]` + `0/15/30/45` мин, ширина `randint(150, 210)` мин, закрытие ≤ `17:45`;
длительность `base_duration_min * uniform(0.8, 1.2)`.
`full` дополнительно: 2 дальние заявки в `FAR_CORNERS` с окном `10:00-14:00`; 3 широких окна `09:00-18:00`;
**6 VIP** с `window_strict=True` и 60-минутным окном из `{10:00, 10:30, 11:00, 14:00, 14:30, 15:00}`.

**Каталог работ** `WORK_TYPES` (`:56-68`), 8 типов: `install_inet` (60 мин, fiber, onr+router_wifi6),
`replace_router` (30, fiber), `repair_line` (90, network+splice), `install_video` (120, video, thermal_camera,
только `van`/`van_ladder`), `setup_tv` (30, video, stb), `audit_node` (45, network), `b2b_maintenance` (60, network),
`consultation` (20, без требований).

**Привязки к реальному датасету `data/` НЕТ.** Ни один модуль `core/` не читает `data/`.

CLI: `python -m core.gen --scenario {mini,full} --seed 42 --date 2026-09-14 --out file.json`.

---

## 7. Studio (`core/studio.py` + `core/studio.html`)

Дев-инструмент, не продуктовый API. FastAPI + uvicorn, одностраничный UI.
Запуск: `python -m core.studio --scenario full --seed 42 --port 8017`.

**Карта — MapLibre GL 5.6.0 с CDN unpkg**, растровые тайлы OSM `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
без ключа. Leaflet явно НЕ используется. **Требуется интернет** — офлайн-контура нет.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/` | отдаёт `studio.html` |
| GET | `/api/state` | план, маршруты, метрики, reasons, каталог работ, `last_event` |
| POST | `/api/requests` | добавить заявку по клику на карте → перепланирование (warm start) |
| POST | `/api/requests/{id}/cancel` | снять заявку → перепланирование |
| POST | `/api/weights` | сменить веса (what-if) → перепланирование |
| POST | `/api/reset` | вернуть исходный сид-датасет |

**Умеет:** палитра из 12 цветов инженеров; линии маршрутов как GeoJSON-слой `routes`; маркеры;
чипы метрик (assigned / sla / travel / solve_ms) и чипы diff (`added`, `cancelled`, `reassigned`, `shifted`);
**Ганта-таймлайн** по инженерам с заштрихованным ожиданием и строкой «не назначены»;
панель «Почему так» / «Почему не назначена»; форма добавления заявки; кнопка «Сброс дня»;
три пресета весов: `std {sla:100000, balance:500, travel:1}`, `sla {sla:1000000,...}`, `travel {sla:10000,...}`.

**Готовность к демо:** высокая для инженерного демо, но это дев-инструмент: состояние в памяти процесса,
зависимость от интернета для тайлов, нет экспорта маршрутных листов, нет сравнения с бейзлайном.

---

## 8. Перепланирование

Реализовано как **warm start**, без штрафа за нестабильность.
Цепочка: `solve_task(..., previous_plan=plan)` → `previous_routes` из назначений → `ReadAssignmentFromRoutes`
→ метрики получают `moves_vs_prev`.

| Событие | Где | Статус |
|---|---|---|
| Добавление новой заявки | `Studio.add_request` `core/studio.py:102-129` | есть |
| Отмена заявки | `Studio.cancel_request` `:131-142` | есть |
| Смена весов целевой (what-if) | `Studio.set_weights` `:144-148` | есть |
| Сброс дня | `Studio.reset` `:150-155` | есть |

**Чего НЕТ:** выпадение инженера, поломка машины, задержка визита, пробка, перенос окна клиентом,
«замороженные» выполненные визиты (нет понятия `now` и статуса визита), закрепление `fix`,
штраф `w_stab` за перемещения.

Техническая заметка: `ReadAssignmentFromRoutes` принимает **внутренние индексы менеджера**, не номера
узлов — нужен `NodeToIndex` (`core/model.py:258-260`).

---

## 9. Тесты и golden-план

`core/pytest.ini`: `filterwarnings = ignore::DeprecationWarning`. Запуск: `python -m pytest core/tests -q`.

| Файл | Что покрывает |
|---|---|
| `test_types.py` | round-trip времени, парс входа, `hard_window`, форма `solution_to_dict` |
| `test_matrix.py` | haversine (центр Москвы ↔ Зеленоград 35-45 км), кривая коэффициентов, симметрия, пик медленнее |
| `test_model.py` | префильтр, жёсткие ограничения, полный пайплайн (`sla_ok_pct == 75.0`), порядок факторов, бесплатный дроп |
| `test_gen.py` | детерминизм, формы `mini`/`full`, 6 VIP, 3 CCTV, 3 фургона, 2 тепловизора, покрытие навыков |
| `test_replan.py` | `warm_started is True`, добавление/отмена, детерминизм warm-start, паритет warm vs cold |
| `test_studio.py` | HTTP-поверхность: `maplibre-gl` есть, Leaflet нет, все endpoints, 400 на неизвестные id |
| `test_golden.py` | golden-гейт |

**Golden dataset:** `mini_input.json` (seed 42, 5 инженеров, 10 заявок, смены 09:00-18:00, `end: null`)
и `mini_solution.json`. Параметры прогона: `{"time_limit_ms": 1500, "solution_limit": 100}`.
Три проверки: три прогона байт-идентичны; план равен снапшоту; `assigned == 10`, `unassigned == 0`,
`sla_ok_pct == 100.0`, `solve_ms < 2000`.

Фактические метрики golden-плана: `travel_min_total = 642`, `travel_min_mean_per_eng = 128.4`,
`wait_min_total = 105`, `makespan_min = 511`, `balance_std_min = 195.0`,
`workload_min = {eng_01: 511, eng_02: 129, eng_03: 57, eng_04: 98, eng_05: 467}` — **баланс крайне
неравномерный, что прямо подтверждает отсутствие балансировки в целевой функции**.

---

## 10. Пробелы: требование → статус → где в коде

| # | Требование кейса | Статус | Где / чего не хватает |
|---|---|---|---|
| 1 | Автоматическое распределение | **есть** | `core/model.py:160` `solve()`, `core/solve.py:32` |
| 2 | Последовательность визитов | **есть** | измерение `"Time"` + `seq`, `core/model.py:339-356` |
| 3а | Навыки / оборудование / транспорт | **есть** | `prefilter` `core/model.py:106-139` + `VehicleVar.SetValues` `:249` |
| 3б | Окна клиента, смены | **есть** | `core/model.py:233-237`, `:251-253` |
| 3в | Обед, перерывы, переработка | **нет** | `SetBreakIntervalsOfVehicle` не используется |
| 4 | Мягкие ограничения / приоритеты | **частично** | мягкая верхняя граница окна есть; VIP = только жёсткое окно |
| 5 | Карта с маршрутами | **есть** | `core/studio.html` (MapLibre GL + OSM raster) |
| 6 | Одно перепланирование | **частично** | warm start на добавить/снять; нет выпадения инженера, `now`, заморозки, `fix` |
| 7 | Объяснения решений | **есть** | `core/reasons.py` |
| 8 | Обязательные метрики | **есть** | `core/metrics.py:32-99` |
| 9 | **Сравнение с бейзлайном** | **НЕТ** | ни модуля, ни функции |
| 10 | **Работа на реальном датасете** | **НЕТ** | нет парсера CSV, нет геокодирования, нет маппинга типов заявок |
| 11 | Реальные времена в пути (OSRM) | **НЕТ** | только haversine ×1.35 / 28 км/ч, один час на весь солв |
| 12 | Балансировка в целевой | **НЕТ** | `weights["balance"]` не применяется |
| 13 | **Минимизация числа исполнителей** | **НЕТ** | `SetFixedCostOfVehicle` не вызывается |
| 14 | **Open route** (без возврата) | **НЕТ** | `end=None` → возврат в `start` |
| 15 | Смены через полночь | **НЕТ** | `parse_hhmm` отвергает часы > 23 |
| 16 | Продуктовый API / БД | **НЕТ** | только дев-студия в памяти процесса |
| 17 | Офлайн-демо | **НЕТ** | тайлы MapLibre с CDN |
| 18 | Детерминизм | **есть** | сортировка по id, `solution_limit`, golden-гейт |

### Дополнительные технические пробелы

- `weights["travel"]` не используется в целевой; `UNASSIGNED_PENALTY` — константа, не конфигурируется.
- Скорость одинакова для `sedan` и `van` — класс транспорта влияет только на допуск, не на время в пути.
- Нет уровней квалификации (грейдов) — навык бинарный.
- Оборудование — счётчик в списке инженера, не расходуемый ресурс.
- `reasons`: `alternatives` и `sequence` считают дельту только по пробегу, игнорируя влияние на окна.
- Пороги объяснений (15 / 90 / 60 мин) захардкожены.

---

## Резюме (то, с чем нельзя конфликтовать)

**Готово:** OR-Tools **Routing** (не CP-SAT) мультидепо VRPTW; жёсткие ограничения по
навыкам/оборудованию/транспорту/смене через префильтр + `VehicleVar.SetValues`; жёсткая нижняя и
жёсткая-для-VIP/strict верхняя граница окна, иначе мягкая с линейным штрафом; warm-start
перепланирование на добавление/отмену; правиловые объяснения (6 факторов + 4 кода блокировки +
2 кода неназначения); 13 метрик; сид-генератор `mini` 5×10 и `full` 10×80; карта на MapLibre GL с
OSM-тайлами, Ганта-таймлайн, панель причин; golden-гейт детерминизма.

**Нет:** бейзлайна и сравнения с ним; работы с реальным датасетом; OSRM; балансировки в целевой;
**минимизации числа исполнителей**; **open route**; обедов/перерывов; `fix`-закрепления и штрафа за
нестабильность; понятия «текущее время / уже выполненный визит»; смен через полночь; продуктового
API/БД; офлайн-демо.

**Зафиксированные имена и константы** (использовать их, не изобретать новые):

- Сущности — `SolverInput`, `PlanSolution`, `Engineer`, `Request`, `Assignment`, `Unassigned`, `Metrics`,
  `TravelMatrixSpec`, `FixEntry`, `CandidateInfo`, `SolveOutput`.
- Поля — `shift_start_min`/`shift_end_min`, `window_open_min`/`window_close_min`, `window_strict`,
  `service_min`, `required_skills`, `required_equipment`, `allowed_vehicle_classes`, `priority`,
  `vehicle_class`, `equipment`, `eta_min`, `done_by_min`, `travel_from_prev_min`, `wait_min`, `seq`,
  `moves_vs_prev{reassigned,shifted}`.
- Словари значений — навыки `fiber|network|splice|video`; транспорт `sedan|van|van_ladder` + wildcard `any`;
  приоритет `std|vip`; оборудование `onr|router_wifi6|splice_kit|thermal_camera|stb`; блокировки
  `skill_missing|equipment_missing|vehicle_class|shift_window`; факторы
  `skill_match|equipment_ok|sla_margin|window_tight|travel_delta|load_balance`; неназначение
  `no_candidate|window_conflict`.
- Числа — `DEFAULT_WEIGHTS = {sla:100000, balance:500, travel:1}`; `UNASSIGNED_PENALTY = 1_000_000`;
  `MAX_WAIT_MIN = 240`; `HORIZON_MIN = 1440`; `SHIFTED_ETA_MIN = 5`; `BASE_SPEED_KMH = 28.0`;
  `ROAD_FACTOR = 1.35` (эффективно ≈ 20.74 км/ч); `PEAK_COEFF = 1.4` в часы {7,8,9,17,18,19};
  `NIGHT_COEFF = 0.9`; дефолтный `time_limit_ms = 1500` (студия — 1000), golden — `solution_limit = 100`;
  пороги объяснений 15 / 90 / 60 мин; смены генератора `09:00-18:00`; seed 42, дата `2026-09-14`; порт 8017.
- Эталонные числа: golden mini — 10/10, SLA 100 %, travel 642 мин, balance_std 195.0; full — 71/80, SLA 88.8 %.

---

## ⚠️ Критический вывод для исследования

Существующее ядро **расходится с ТЗ кейса в четырёх местах, и все четыре — обязательные требования**:

| Расхождение | Требование ТЗ | Последствие, если не починить |
|---|---|---|
| Возврат в стартовую точку (`end=None` → `start`) | §2.4: «возвращение в стартовую точку не требуется» | Пробег (M-02) завышен на обратный перегон — метрика некорректна |
| Нет `SetFixedCostOfVehicle` | §2.3 M-01: минимум задействованных исполнителей | **Первая обязательная метрика вообще не оптимизируется** |
| Нет бейзлайна | §2.3, §4.7, §8.1: сравнение обязательно | Прямой минус по критерию «Эффективность» (15 %) и по вопросу жюри №4 |
| Свои словари (`fiber/network/splice/video`, `sedan/van`) | §2.4.1: закрытые справочники из 3 навыков и 4 типов транспорта | Несоответствие ТЗ на уровне данных; жюри увидит «решали не нашу задачу» |

Эти четыре пункта должны стать первыми задачами агентам-исполнителям.
