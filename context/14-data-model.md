# Модель данных и тестовые датасеты

> Назначение: единая схема данных для БД, API, солвера и генератора датасетов. Плюс план демо-датасета. Пока не знаем формат файлов организаторов — наша схема покрывает все поля ТЗ; адаптер будет маппить.

---

## 1. ER-обзор

```
work_types ──< work_type_equipment >── equipment
    │  (навыки: work_type.required_skills)
    └──< requests >── districts
engineers ──< engineer_skills >── skills
engineers ── vehicles (0..1)
plans ──< plan_assignments >── requests     (версионные снимки)
plan_events                                  (лента событий/перепланирований)
distance_matrix_cache                        (пары координат → минуты)
```

## 2. Схема таблиц (PostgreSQL, ключевые поля)

```sql
-- Справочники
CREATE TABLE work_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,            -- 'install_inet', 'replace_router', 'repair_line', 'install_video', 'setup', 'audit_node'
  base_duration_min INT NOT NULL,                     -- базовая длительность
  required_skills TEXT[] NOT NULL,                    -- ['fiber', 'video', 'network']
  allowed_vehicle_classes TEXT[] NOT NULL DEFAULT '{any}'
);

CREATE TABLE equipment (
  id TEXT PRIMARY KEY, name TEXT NOT NULL             -- 'onr', 'router_wifi6', 'stb', 'thermal_camera', 'splice_kit'
);

CREATE TABLE work_type_equipment (                      -- матрица ТЗ «работа → оборудование»
  work_type_id TEXT REFERENCES work_types,
  equipment_id TEXT REFERENCES equipment,
  qty INT NOT NULL DEFAULT 1,
  PRIMARY KEY (work_type_id, equipment_id)
);

CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL);

-- Инженеры
CREATE TABLE engineers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  base_location GEOGRAPHY(Point) NOT NULL,            -- офис или дом
  shift_start TIME NOT NULL, shift_end TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'free'                 -- free|driving|working|offline
);
CREATE TABLE engineer_skills (
  engineer_id TEXT REFERENCES engineers, skill_id TEXT REFERENCES skills,
  PRIMARY KEY (engineer_id, skill_id)
);
CREATE TABLE vehicles (
  id TEXT PRIMARY KEY, engineer_id TEXT REFERENCES engineers,
  class TEXT NOT NULL                                 -- 'sedan'|'van'|'van_ladder'
);

-- Заявки
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  location GEOGRAPHY(Point),                          -- результат геокодинга
  geocode_status TEXT NOT NULL DEFAULT 'pending',     -- ok|approx|manual|failed
  work_type_id TEXT REFERENCES work_types,
  window_start TIMETZ NOT NULL, window_end TIMETZ NOT NULL,
  window_strict BOOLEAN NOT NULL DEFAULT TRUE,
  duration_min INT,                                   -- если отличается от base_duration
  priority TEXT NOT NULL DEFAULT 'std',               -- vip|std
  sla_deadline TIMETZ,                                -- опционально, для не-окна SLA
  contact TEXT, comment TEXT,
  external_id TEXT,                                   -- id из файла организаторов
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Планы (иммутабельные версии)
CREATE TABLE plans (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES plans,   -- цепочка версий
  date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  trigger TEXT NOT NULL,                                  -- manual|new_request|cancel|delay|engineer_down|weights
  solver_name TEXT, solve_ms INT,
  metrics JSONB NOT NULL,                                 -- см. §4
  reasons JSONB NOT NULL                                  -- см. 11-explainability.md
);
CREATE TABLE plan_assignments (
  plan_id TEXT REFERENCES plans, request_id TEXT REFERENCES requests,
  engineer_id TEXT REFERENCES engineers,
  seq INT NOT NULL,                                       -- порядок в маршруте
  eta_from TIMETZ, eta_to TIMETZ,                         -- расчётное время визита
  travel_from_prev_min INT NOT NULL, wait_min INT NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, request_id)
);
CREATE TABLE plan_diffs (                               -- дельта между версиями (для UX)
  plan_id TEXT PRIMARY KEY REFERENCES plans, diff JSONB NOT NULL
);

-- Гео-кэш
CREATE TABLE distance_matrix_cache (
  a GEOGRAPHY(Point), b GEOGRAPHY(Point), day_hour SMALLINT,  -- hour для трафик-коэффициентов
  travel_min REAL NOT NULL, source TEXT, computed_at TIMESTAMPTZ,
  PRIMARY KEY (a, b, day_hour)
);
```

Для хакатона допустимо упростить: GEOGRAPHY → две REAL-колонки lat/lon, PostGIS не обязателен.

## 3. JSON-контракты (API ↔ солвер)

```jsonc
// SolverInput
{
  "date": "2026-09-20",
  "engineers": [{
    "id": "eng_01", "start": {"lat": 55.75, "lon": 37.61}, "end": null,   // null = вернуться на старт
    "shift": ["09:00", "18:00"], "skills": ["fiber","video"],
    "vehicle_class": "van", "equipment": ["onr","splice_kit","thermal_camera"]
  }],
  "requests": [{
    "id": "req_101", "lat": 55.79, "lon": 37.54,
    "window": ["10:00","12:00"], "window_strict": true,
    "service_min": 60, "required_skills": ["video"],
    "required_equipment": {"thermal_camera": 1},
    "allowed_vehicle_classes": ["any"], "priority": "vip"
  }],
  "travel_matrix": {"src": "osrm", "resolution": "min", "hour_coeff": {…}},
  "weights": {"sla": 100000, "balance": 500, "travel": 1},   // что-то для what-if
  "fix": {"req_098": {"engineer": "eng_02", "seq_before": 3}} // фиксация для стабильности (см. 07)
}

// PlanSolution
{
  "assignments": [{"request": "req_101", "engineer": "eng_03", "seq": 2,
                    "eta": "11:20", "done_by": "12:20", "travel_from_prev": 8, "wait": 0}],
  "unassigned": [{"request": "req_77", "why": "no_candidate: нет инженера с навыком fiber в окне"}],
  "metrics": {"sla_ok_pct": 100, "late_min_total": 0, "travel_min_total": 612,
               "balance_std_min": 22, "makespan_min": 540},
  "solve_ms": 812, "improvement_vs_greedy_pct": 23
}
```

## 4. Метрики плана (единый объект `metrics`)

```jsonc
{
  "requests_total": 80, "assigned": 79, "unassigned": 1,
  "sla_ok_pct": 97.5, "sla_at_risk": 2, "late_total_min": 0,
  "travel_min_total": 612, "travel_min_mean_per_eng": 61.2,
  "workload_min": {"eng_01": 432, "eng_02": 447, …},   // для баланс-диаграммы
  "balance_std_min": 22, "makespan_min": 540,
  "wait_min_total": 45, "moves_vs_prev": {"reassigned": 2, "shifted": 3}
}
```

## 5. Тестовые датасеты

### 5.1 Fallback-датасет (наш, пока не дали организаторы)
- Город: Москва (или СПб) — реалистичные кластеры по 6–8 районам.
- **Инженеры: 10** — 6 из офиса, 4 из дома; навыки: fiber (5), video (3), network (7), splice (2); ТС: 3 фургона, 7 легковых; оборудование распределяем так, чтобы 1–2 заявки имели дефицит (для показа проверки).
- **Типы работ: 8** — подключение интернета (60 мин), замена роутера (30), ремонт линии (90, splice), настройка ТВ (30), монтаж видеонаблюдения (120, video+thermal), аудит узла (45, network), ТО B2B (60), консультация (20).
- **Заявки: 80** — 70% в кластерах, окна: утро/день/вечер с пиком 10–12 и 14–17; 6 заявок VIP (узкое окно 1 ч), 3 с широкими окнами; 2 заявки — заведомо «сложные» (далеко от всех).
- **Дистрибуция длительностей:** базовая ±20%.

### 5.2 Демо-сценарный seed (для репетиции, `13-demo`)
- Тот же датасет + фиксация: в 11:30 приходит VIP-заявка (видеонаблюдение, окно 12:00–14:00, юго-запад); план перепланируется детерминированно (фикс. seed солвера) → 2 передачи/3 сдвига/риски 2→1. Проверить 3 раза подряд идентичность.
- Дополнительные события-триггеры: отмена (11:50), опоздание инженера (12:10), поломка ТС (12:40) — заготовки кнопок симулятора.

### 5.3 Генератор (скрипт `data/gen.py`)
- Параметры: город/bbox, кластеры, n_инженеров, n_заявок, seed.
- Выход: JSON по схеме §3 + CSV для импорта.
- Адреса: реальные улицы из OSM-выгрузки района (или готовый список из 100 адресов с координатами — прогеокодировать заранее, см. `06`).

## 6. Правила целостности (валидатор)

1. У каждой заявки `work_type` существует; требуемые навыки покрываются ≥1 инженером (иначе — валидационное сообщение в UI при импорте).
2. Матрица work_type_equipment замкнута: нет оборудования вне справочника.
3. Окна в границах смен хотя бы одного инженера с нужными навыками.
4. Координаты: 100% заявок имеют `geocode_status=ok|manual` до планирования (failed → блокер, показываем в UI).
5. Демо-датасет проверяется скриптом: солвер сходится, метрики в ожидаемых пределах.
