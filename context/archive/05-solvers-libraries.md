> ⚠️ **АРХИВ (2026-09-15).** Файл устарел и не развивается. Актуальное содержание: выбор зафиксирован (D-1, OR-Tools); актуальный документ: `40-or-tools-research.md`. Сохранён как история решений и источник цитат D-№ (цитаты вида `NN` в `29-decision-log.md` указывают сюда, в `context/archive/`).

# Солверы и библиотеки: что взять для нашей задачи

> Назначение: выбрать оптимизационное ядро за один вечер, а не неделю. Короткий вердикт: **OR-Tools (Python) — основное ядро; Timefold — запасная альтернатива с лучшей объяснимостью; VROOM — «дёшево и сердито» с API; PyVRP — SOTA-качество на классике, но без навыков; самописный ALNS — только если захочется полного контроля и будет время.**

---

## 1. Сравнительная таблица

| Инструмент | Язык | VRPTW | Навыки/совместимость | Мульти-депо | Динамика | Объяснимость | Интеграция | Вердикт для нас |
|---|---|---|---|---|---|---|---|---|
| **Google OR-Tools** (Routing) | C++/Python/Java/JS | ✅ | ✅ (allowed vehicles, dimensions) | ✅ | ✅ (пересборка мс) | ⚠️ вручную из переменных | ✅ pip, зрелый API | **Основной выбор** |
| **Timefold Solver** (ex-OptaPlanner) | Java/Kotlin + **Python** (pip install timefold-solver) | ✅ | ✅ (любые constraint streams) | ✅ | ✅ real-time planning из коробки | ✅✅ score breakdown по каждой constraint | ⚠️ Python-версия моложе | Сильная альтернатива; лучший «score → причины» |
| **VROOM** | C++ (HTTP API) | ✅ | ✅ (skills) | ✅ | ⚠️ пересборка | ❌ минимум | ✅ готовый /vroom-сервер + интеграция с OSRM/ORS | Быстрый старт, но мягкие цели (балансировка, SLA-веса) слабые |
| **PyVRP** | Python (C++ ядро, HGS) | ✅ | ❌ нативно нет | ✅ (новые версии) | ⚠️ | ❌ | ✅ pip | Для бенчмарков/бонуса; наши ограничения не лезут напрямую |
| **jsprit** | Java (GraphHopper) | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ Java-стек | Не наш стек |
| **Hexaly** (ex-LocalSolver) | коммерческий | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ лицензия | Нет |
| **CP-SAT** (OR-Tools) | Python | ⚠️ scheduling-стиль | ✅ | ✅ | ✅ | ⚠️ | ✅ | Запасной путь «расписание + маршруты в одном CP», сложнее |
| **Самописный ALNS/LNS** | Python/TS | ✅ | ✅✅ | ✅ | ✅ | ✅✅ | — | Только как осознанный план Б (см. `04`) |

(Версии/фичи — на момент ресерча 2025–2026; перед хакатоном пробно прогнать каждый на нашем датасете.)

## 2. OR-Tools: как лягут наши ограничения

Модель Routing Model + dimensions:

```python
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

def solve(engineers, requests, travel_matrix, service_times, params):
    # engineers[i]: start_idx, end_idx, shift_start, shift_end, skills, equipment
    # requests[j]: node index, window [tw_open, tw_close], service_time,
    #              required_skill, allowed_engineer_ids (по навыку+оборудованию+транспорту)
    mgr = pywrapcp.RoutingIndexManager(
        n_nodes, len(engineers),
        [e.start_node for e in engineers],       # старт каждого инженера (мульти-депо)
        [e.end_node for e in engineers])
    routing = pywrapcp.RoutingModel(mgr)

    # 1) Время в пути + сервис = "time dimension"
    def travel_cb(i, j):
        a, b = mgr.IndexToNode(i), mgr.IndexToNode(j)
        return travel_matrix[a][b] + service_times[a]
    t_idx = routing.RegisterTransitCallback(travel_cb)
    routing.AddDimension(t_idx, 0,              # slack=0 → без ожиданий;slack>0 разрешит waiting
                         MAX_SHIFT_SEC, True, "time")
    time_dim = routing.GetDimensionOrDie("time")

    for j, r in enumerate(requests):
        node = mgr.NodeToIndex(r.node)
        time_dim.CumulVar(node).SetRange(r.tw_open, r.tw_close)   # окно
        routing.SetAllowedVehiclesForIndex(r.allowed_engineers, node)  # навык+оборудование+транспорт

    for e_id, eng in enumerate(engineers):
        time_dim.CumulVar(routing.Start(e_id)).SetRange(eng.shift_start, eng.shift_start)
        time_dim.CumulVar(routing.End(e_id)).SetRange(0, eng.shift_end)

    # 2) SLA как мягкие окна: спускать жёсткость, штрафовать опоздание
    #    (практика: держать жёсткое окно на VIP, мягкое на остальных)
    # 3) Балансировка: вторая dimension "workload" + штраф за перегруз (SetGlobalSpanCostCoefficient / CumulVar soft bounds)
    # 4) Цель: minimize суммарного транзит-времени (+ штрафы выше)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = params.time_limit.FromMilliseconds(1500).seconds  # тюнить

    sol = routing.SolveWithParameters(params)
    return extract_routes_and_reasons(sol, mgr, routing, time_dim, requests, engineers)
```

Практические нюансы (грабли, о которых стоит знать заранее):
- Всё время — **в секундах**, целыми числами. Сервисное время включаем в transit-callback или отдельным узлом, главное — не учесть дважды.
- `slack` в time dimension = допустимое ожидание в точке. Slack=0 запрещает ждать; иногда полезно разрешить (slack>0), иначе план с окнами станет неоптимальным.
- Опоздание моделируется через мягкие окна (`SetCumulVarSoftUpperBound`) или расширенные жёсткие окна + штраф — выбрать один способ сразу.
- «Причины» не выдаются — после решения читаем CumulVar (время прибытия), slack, allowed vehicles; строим reasons-объект сами (см. `11-explainability.md`).
- Перепланирование: для масштаба ≤100 заявок **честно пересобираем модель на каждое событие** — это миллисекунды; трюки с инкрементальностью не нужны (но сохраняем предыдущий план как `ReadAssignmentFromRoutes` warm start — полезно и для стабильности).
- Детерминизм для демо: фиксируем seed/лимиты, иначе «план поменялся сам» при одинаковых данных.

## 3. Timefold: почему это серьёзная альтернатива

- Python-версия: `pip install timefold-solver` (официальный [репозиторий](https://github.com/TimefoldAI/timefold-solver-python), [блог анонса](https://timefold.ai/blog/new-open-source-solver-python)).
- Ограничения описываются как **constraint streams** — каждая constraint приносит читаемые score-пенальти по конкретным сущностям: «ShiftOverload у Иванова +40 мин», «SLA-нарушение заявки №12». Это почти готовая система объяснений (наш пункт ТЗ №5).
- **Real-time planning** — события (новая заявка) подаются в работающий solver, план обновляется инкрементально (problem fact changes) — то, что нужно для пункта ТЗ №4.
- Риск: Python-версия моложе Java; для хакатона надо проверить, что наш набор ограничений (окна+навыки+оборудование+баланс) собирается за день. Если да — Timefold даёт лучшие «причины» почти бесплатно.

Рекомендация: день 0 — собрать прототип модели на **обоих** (OR-Tools и Timefold) на мини-датасете, выбрать по скорости внедрения и качеству объяснений. Если оба закапризничали — самописный regret insertion + LNS (это 300–500 строк, и он полностью объясним).

## 4. VROOM: когда подходит

- HTTP API из коробки (docker-образ), skills и временные окна поддержаны, связка с OSRM «матрица+маршруты» — готовая схема.
- Минусы: мягкие цели (SLA-штрафы, балансировка, стабилизация плана) ограничены; объяснений нет.
- Годится, если захотим сэкономить время на солвере и вложить его в UX. Для нашей «объяснимости» всё равно придётся дописывать слой причин.

## 5. PyVRP

- Реализация HGS, SOTA-качество на CVRP/VRPTW бенчмарках ([pyvrp.org](https://pyvrp.org/)); мульти-депо поддержан в новых версиях.
- Навыков/совместимости нет нативно — наши «работа→оборудование» придётся моделировать через разбиение на подзадачи или vehicle types, что для динамического дня неудобно.
- Полезен как «эталон» для сравнения качества нашего плана (бонус-слайд: «наш солвер в пределах 3% от HGS»).

## 6. Рекомендуемая связка для проекта (итог)

1. **Солвер-сервис** (Python, отдельный модуль): OR-Tools как ядро; интерфейс `solve(plan_input) -> PlanSolution` c reasons.
2. **Слой причин**: свой модуль, читающий решение OR-Tools → structured reasons (см. `11-explainability.md`). Решение о Timefold принимаем в день 0 по прототипам.
3. **Матрицы расстояний**: OSRM /table + кэш (см. `06-routing-maps-engines.md`).
4. Критерий выбора в день 0: модель собирается ≤1 день, полный пересчёт на датасете ≤2 c, причины извлекаются.

## 7. Источники

- [OR-Tools Routing docs](https://developers.google.com/optimization/routing) (Google)
- [Timefold Solver Python — GitHub](https://github.com/TimefoldAI/timefold-solver-python), [PyPI](https://pypi.org/project/timefold-solver/), [анонс](https://timefold.ai/blog/new-open-source-solver-python)
- [VROOM — GitHub](https://github.com/vroom-project/vroom), [vroom-project.org](http://vroom-project.org/)
- [PyVRP docs](https://pyvrp.org/), статья Wouda et al. 2024 (OR Spectrum)
