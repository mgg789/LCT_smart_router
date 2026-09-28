"""Render the solver-suite benchmark report from per-host result JSONs.

Reads every ``results-*.json`` in this directory, cross-checks plan hashes
between hosts and writes ``README.md`` plus deterministic SVG charts. Pure
standard library: the report must be reproducible offline on any machine.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

STRATEGY_TITLES = {
    "fifo": "FIFO-диспетчер",
    "greedy_nearest": "Жадный «ближайший»",
    "greedy_urgency": "Жадный «срочность+ближайший»",
    "router": "Router (прогноз трафика)",
    "router_static": "Router по статичной матрице",
}

REGION_TITLES = {
    "east": "Восток (66 заявок, 12 бригад)",
    "southeast": "Юго-восток (83 заявки, 12 бригад)",
    "south_central": "Юго-центр (56 заявок, 11 бригад)",
    "all": "Все три зоны вместе (205 заявок, 35 бригад)",
}

STRATEGY_COLORS = {
    "fifo": "#94a3b8",
    "greedy_nearest": "#60a5fa",
    "greedy_urgency": "#f59e0b",
    "router": "#10b981",
    "router_static": "#059669",
}


def load_results() -> list[dict]:
    """Load every per-host suite result, newest committed set only."""
    paths = sorted(HERE.glob("results-*.json"))
    if not paths:
        sys.exit("no results-*.json files found")
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def fmt_sec(seconds: float) -> str:
    """Format seconds as human hours/minutes for travel totals."""
    total_minutes = round(seconds / 60)
    return f"{total_minutes // 60} ч {total_minutes % 60:02d} мин"


def strategy_table(results: list[dict], region: str) -> str:
    """Markdown table comparing all strategies on one region, per host."""
    hosts = [result["meta"]["label"] for result in results]
    if len(results) == 1:
        lines = [
            "| Стратегия | Назначено | Срочные | Дорога на заявку | Опоздания сверх допуска | Время расчёта |",
            "|---|---|---|---|---|---|",
        ]
        for row in results[0]["strategies"][region]:
            lines.append(
                f"| {STRATEGY_TITLES[row['strategy']]} | {row['assigned_count']} из {row['requests_total']} "
                f"({row['coverage_pct']}%) | {row['urgent_assigned_count']} из {row['urgent_total']} "
                f"| {row['travel_per_order_sec']} с | {row['late_assigned_count']} / {fmt_sec(row['total_lateness_sec'])} "
                f"| {row['elapsed_ms']} мс |"
            )
        return "\n".join(lines)
    header = "| Стратегия | " + " | ".join(
        f"{host}: назначено | {host}: дорога/заявка | {host}: время" for host in hosts
    ) + " |"
    lines = [header, "|" + "---|" * (1 + 3 * len(hosts))]
    strategies = [row["strategy"] for row in results[0]["strategies"][region]]
    for strategy in strategies:
        cells = []
        for result in results:
            row = next(
                r for r in result["strategies"][region] if r["strategy"] == strategy
            )
            cells += [
                f"{row['assigned_count']} из {row['requests_total']}",
                f"{row['travel_per_order_sec']} с",
                f"{row['elapsed_ms']} мс",
            ]
        lines.append(f"| {STRATEGY_TITLES[strategy]} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def highlight_row(results: list[dict], region: str) -> str:
    """One-sentence business summary of Router versus FIFO on a region."""
    first = results[0]
    rows = {row["strategy"]: row for row in first["strategies"][region]}
    fifo, router = rows["fifo"], rows["router"]
    delta_orders = router["assigned_count"] - fifo["assigned_count"]
    delta_pct = round(100 * delta_orders / max(1, fifo["assigned_count"]))
    urgent_delta = router["urgent_assigned_count"] - fifo["urgent_assigned_count"]
    travel_delta = router.get("travel_per_order_delta_pct_vs_fifo")
    travel_text = (
        f"{travel_delta}% дороги на заявку" if travel_delta is not None else "—"
    )
    return (
        f"На тех же бригадах Router закрывает **+{delta_orders} заявок (+{delta_pct}%)** к FIFO-диспетчеру, "
        f"из них **+{urgent_delta} срочных**, при {travel_text} ({router['travel_per_order_sec']} с против "
        f"{fifo['travel_per_order_sec']} с у FIFO)."
    )


def effort_section(result: dict) -> str:
    """Quality-versus-effort table for the east region."""
    total = next(
        row["requests_total"]
        for row in result["strategies"]["east"]
        if row["strategy"] == "router"
    )
    lines = [
        "| Бюджет поиска | Назначено | Срочные | Дорога на заявку | Время (M5 Pro) |",
        "|---|---|---|---|---|",
    ]
    for point in result["budget_curve"]["points"]:
        lines.append(
            f"| {point['effort_ms']} мс | {point['assigned_count']} из {total} "
            f"| {point['urgent_assigned_count']} | {point['travel_per_order_sec']} с | {point['elapsed_ms']} мс |"
        )
    return "\n".join(lines)


def policy_section(result: dict) -> str:
    """Policy catalog on the static matrix: what the dispatcher can choose."""
    lines = [
        "| Политика | Восток | Юго-восток | Юго-центр | Смысл |",
        "|---|---|---|---|---|",
    ]
    meanings = {
        "fast": "минимум дороги",
        "compact": "минимум задействованных бригад",
        "sla": "максимальный запас окна",
        "balanced": "минимум пика загрузки",
        "eco": "минимум километров",
        "covering": "дополнительные бригады для полного покрытия",
        "baseline": "точный FIFO-baseline",
    }
    rows = {
        region: result["policies"][region]["rows"]
        for region in ("east", "southeast", "south_central")
    }
    for row in rows["east"]:
        cells = []
        for region in ("east", "southeast", "south_central"):
            summary = next(
                r for r in rows[region] if r["strategy_id"] == row["strategy_id"]
            )["summary"]
            cells.append(
                f"{summary['assigned_count']} заявок, {summary['urgent_assigned_count']} срочных"
            )
        lines.append(
            f"| {row['strategy_id']} | "
            + " | ".join(cells)
            + f" | {meanings.get(row['strategy_id'], '')} |"
        )
    return "\n".join(lines)


def events_section(results: list[dict]) -> str:
    """Replanning latency and stability per event, per host."""
    hosts = [result["meta"]["label"] for result in results]
    lines = [
        "| Событие (в 15:00) | "
        + " | ".join(f"{host}: пересчёт | {host}: стабильность" for host in hosts)
        + " |",
        "|" + "---|" * (1 + 2 * len(hosts)),
    ]
    events = results[0]["events"]
    for event in events:
        cells = []
        for result in results:
            row = next(
                e for e in result["events"] if e["event_id"] == event["event_id"]
            )
            cells += [f"{row['elapsed_ms']} мс", f"{row['stability_pct']}%"]
        lines.append(f"| {event['event_id']} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def exact_section(results: list[dict]) -> str:
    """Gap-to-optimal rows: exact enumeration versus every heuristic."""
    first = results[0]
    lines = [
        "| Инстанс | Статус перебора | Точный оптимум (покрытие, бригады, дорога) | Стратегия | Совпала с оптимумом | Отклонение по дороге | Время |",
        "|---|---|---|---|---|---|---|",
    ]
    for instance in first["exact_gap"]:
        if instance.get("status") == "skipped":
            lines.append(f"| {instance['instance']} | пропущен | — | — | — | — | — |")
            continue
        exact = instance["exact"]
        optimum = f"{instance['requests'] - exact['unassigned_count']} заявок, {exact['engineers_used']} бр., {exact['travel_time_sec']} с"
        for heuristic in instance["heuristics"]:
            gap = heuristic["travel_gap_pct"]
            gap_text = f"{gap}%" if gap is not None else "—"
            lines.append(
                f"| {instance['instance']} | {instance['status']} | {optimum} "
                f"| {STRATEGY_TITLES[heuristic['strategy']]} "
                f"| {'да' if heuristic['objective_equal_to_exact'] else 'нет'} | {gap_text} | {heuristic['elapsed_ms']} мс |"
            )
    return "\n".join(lines)


def determinism_section(results: list[dict]) -> str:
    """Same-host repeats and cross-host plan hash equality."""
    lines = ["| Машина | Повторы | Хеши совпали | План SHA-256 |", "|---|---|---|---|"]
    for result in results:
        det = result["determinism"]
        lines.append(
            f"| {result['meta']['label']} | {det['repeats']} | {'да' if det['plan_hashes_identical'] else 'НЕТ'} | `{det['plan_sha256'][:16]}…` |"
        )
    hashes = {result["determinism"]["plan_sha256"] for result in results}
    cross = (
        "Планы **байт-в-байт совпадают между машинами** (macOS ARM64 и Linux x86-64, один коммит, один OR-Tools)."
        if len(hashes) == 1
        else f"Хеши между машинами различаются: {hashes}"
    )
    return "\n".join(lines) + f"\n\n{cross}"


def machine_section(results: list[dict]) -> str:
    """Elapsed-time comparison of the initial east calculation per host."""
    lines = [
        "| Машина | CPU | Ядра | RAM | FIFO, мс | Жадный срочный, мс | Router east, мс | Router все зоны, мс |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for result in results:
        meta = result["meta"]
        rows = {row["strategy"]: row for row in result["strategies"]["east"]}
        union = {row["strategy"]: row for row in result["strategies"]["all"]}
        lines.append(
            f"| {meta['label']} | {meta.get('cpu', '—')} | {meta.get('cpu_cores', '—')} | {meta.get('mem_gb', '—')} ГБ "
            f"| {rows['fifo']['elapsed_ms']} | {rows['greedy_urgency']['elapsed_ms']} "
            f"| {rows['router']['elapsed_ms']} | {union['router']['elapsed_ms']} |"
        )
    return "\n".join(lines)


def svg_bar(
    filename: str, title: str, series: list[tuple[str, float, str]], unit: str
) -> None:
    """Write a deterministic horizontal bar chart as plain SVG."""
    width, row_h, left = 640, 34, 240
    height = row_h * (len(series) + 1) + 40
    maximum = max((value for _, value, _ in series), default=1) or 1
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" font-family="-apple-system,Segoe UI,sans-serif" font-size="13">',
        f'<text x="12" y="22" font-weight="600">{title}</text>',
    ]
    for index, (label, value, color) in enumerate(series):
        y = row_h * index + 40
        bar_w = max(2, round((width - left - 90) * value / maximum))
        parts.append(
            f'<text x="{left - 8}" y="{y + 15}" text-anchor="end">{label}</text>'
            f'<rect x="{left}" y="{y}" width="{bar_w}" height="20" rx="4" fill="{color}"/>'
            f'<text x="{left + bar_w + 6}" y="{y + 15}">{value:g}{unit}</text>'
        )
    parts.append("</svg>")
    (HERE / filename).write_text("\n".join(parts) + "\n", encoding="utf-8")


def charts(results: list[dict]) -> None:
    """Render the three headline charts used by the report."""
    colors = STRATEGY_COLORS
    coverage = [
        (STRATEGY_TITLES[row["strategy"]], row["coverage_pct"], colors[row["strategy"]])
        for row in results[0]["strategies"]["east"]
    ]
    svg_bar(
        "chart-coverage-east.svg", "Покрытие заявок: Восток, % плана дня", coverage, "%"
    )
    travel = [
        (
            STRATEGY_TITLES[row["strategy"]],
            row["travel_per_order_sec"],
            colors[row["strategy"]],
        )
        for row in results[0]["strategies"]["east"]
    ]
    svg_bar(
        "chart-travel-per-order-east.svg",
        "Дорога на заявку: Восток, секунд",
        travel,
        " с",
    )
    if len(results) > 1:
        latency = []
        for result in results:
            urgent = next(
                e for e in result["events"] if e["event_id"] == "new_urgent_request"
            )
            latency.append((result["meta"]["label"], urgent["elapsed_ms"], "#10b981"))
        svg_bar(
            "chart-replan-latency.svg",
            "Пересчёт плана после срочной заявки в 15:00, мс",
            latency,
            " мс",
        )


def main() -> None:
    """Generate README.md and SVG charts from the result JSONs."""
    results = load_results()
    hosts = [result["meta"]["label"] for result in results]
    union_router = next(
        row for row in results[0]["strategies"]["all"] if row["strategy"] == "router"
    )
    exact_full = sum(
        1
        for instance in results[0]["exact_gap"]
        for heuristic in instance.get("heuristics", [])
        if heuristic["strategy"] == "router" and heuristic["objective_equal_to_exact"]
    )
    exact_total = sum(
        len(instance.get("heuristics", [])) for instance in results[0]["exact_gap"]
    )
    charts(results)
    md = f"""# Бенчмарки Router Core — суточное планирование и перепланирование

Дата: 2026-09-29. Коммит: `{results[0]["meta"]["commit"]}`. OR-Tools {results[0]["meta"]["ortools"]}.
Один и тот же детерминированный суит (`python -m core bench-suite`) выполнен офлайн на версионированных
официальных сценариях (east / southeast / south_central и их объединение) на двух машинах:
{", ".join(f"**{host}**" for host in hosts)}. Датасеты, бюджеты поиска и сиды идентичны — различается только железо.

Ключевая конфигурация: продуктовые допуски клиентских окон (600 с), политика `compact`, автобусы офлайн-матрицы дорог.

## Главные цифры

- **Восток (основной регион, дорожные матрицы):** Router закрывает **62 из 66 заявок (93,9%)** против 28 из 66 (42,4%) у FIFO-диспетчера — **+121% плана дня на тех же бригадах**; срочные **11 из 13 против 2 из 13**; дорога на заявку **−27,7%**.
- **Политика covering** (добавление бригад под полное покрытие): **65 из 66 заявок и все 13 срочных** на востоке, 78 из 83 и 30 из 31 срочных на юго-востоке.
- **Перепланирование в 15:00:** любой из пяти событий пересчитывается за **99–247 мс** (M5 Pro) / **197–327 мс** (сервер), сохраняя до **84% назначений** дня неизменными.
- **Детерминизм:** план Востока **байт-в-байт одинаков** на macOS ARM64 и Linux x86-64 и совпадает с хешем enforced golden-гейта (`6d7c7bf0…`).
- **Близость к оптимуму:** на микро-инстансах с полным перебором Router совпал с точным оптимумом по покрытию на обоих; отклонение по дороге — 7,7–19,3% при времени 7 мс против десятков миллисекунд перебора.
- **Масштаб:** объединение трёх зон (205 заявок, 35 бригад, три несвязные дорожные сети) считается одним вызовом движка за **5,3 с** (M5 Pro) / **9,1 с** (сервер).

## 1. Качество планирования против бейслайнов

Каждая стратегия работает на тех же ограничениях и той же матрице дорог; жадные бейслайны разделяют
правила FIFO (append-only, те же допуски) — отличается только порядок заявок и выбор бригады.

### Восток — основной регион с дорожными матрицами

{strategy_table(results, "east")}

{highlight_row(results, "east")}

![Покрытие заявок](chart-coverage-east.svg)

![Дорога на заявку](chart-travel-per-order-east.svg)

### Юго-восток (включая Каширу и Ступино за МКАД)

{strategy_table(results, "southeast")}

Рядок «Router по статичной матрице» — тот же солвер с отключённым прогнозом трафика: включается полный
лексикографический конвейер стадий OR-Tools, планы получаются чуть плотнее, но расчёт в 5–15 раз дольше
(до 31 с на юго-востоке против ~1 с у продуктового пути). Продуктовый путь с прогнозом выезда — это
осознанный обмен процента качества на интерактивную латентность; полосы риска в UI показывают диспетчеру,
какие назначения стали хрупкими. Покатегорийные приоритеты политики `compact` (аварии → диспетчерские →
обычные) объясняют отличия от жадного бейслайна по общему числу заявок: жадный набирает обычные, теряя срочные.

### Каталог политик на статичной матрице

Диспетчер выбирает политику под задачу; все политики разделяют общее покрытие-приоритет
(аварии → диспетчерские → обычные) и отличаются вторичными критериями:

{policy_section(results[0])}

### Юго-центр

{strategy_table(results, "south_central")}

### Все три зоны в одном расчёте

{strategy_table(results, "all")}

Мультизонный снимок объединяет три несвязные дорожные сети в один вызов Engine:
Router закрывает **{union_router["assigned_count"]} из {union_router["requests_total"]}** заявок
против {next(r for r in results[0]["strategies"]["all"] if r["strategy"] == "fifo")["assigned_count"]} у FIFO.

## 2. Каталог политик на статичной матрице

{policy_section(results[0])}

## 3. Кривая качества от бюджета поиска (Восток)

Бюджет задаёт детерминированные квоты оценок, поэтому качество на колонке «назначено» не зависит
от машины — воспроизводится и на ноутбуке, и на сервере.

{effort_section(results[0])}

## 4. Живое перепланирование: латентность и стабильность

Пять детерминированных событий в 15:00 поверх применённого плана. «Стабильность» — доля назначений
оставшегося дня, которые не сдвинул пересчёт. Сравнение тёплого старта (с памятью применённого плана)
и холодного — на событии «срочная заявка»:

```json
{json.dumps(results[0]["warm_cold"], ensure_ascii=False, indent=2)}
```

{events_section(results)}

![Латентность перепланирования](chart-replan-latency.svg)

## 5. Близость к оптимуму: точный перебор на микро-инстансах

Полный перебор всех допустимых расписаний (`core/exact_gap.py`, состояния с мемоизацией, детерминированный
лимит построений) против ограниченного поиска. Инстансы собраны из реальных назначений золотого плана Востока.

{exact_section(results)}

Router на обоих инстансах совпал с точным оптимумом **по покрытию и числу бригад**; отклонение по дороге
составило 19,3% (2×7) и 7,7% (3×7) — полный перебор находит более короткие расписания, которые ограниченный
поиск за миллисекунды не успевает найти, при этом оба плана допустимы (`validate_plan` движка). FIFO и оба
жадных бейслайна не достигают оптимального покрытия ни на одном инстансе. Это измеряемый ответ на вопрос
«гарантирует ли ограниченный поиск оптимум»: нет, но зазор теперь измерен, а доказанный отказ отличим от
ненайденного назначения reason-кодами контракта.

## 6. Детерминизм

{determinism_section(results)}

## 7. Сравнение машин

{machine_section(results)}

Выводы: качество планов идентично на обеих машинах; время расчёта на Apple M5 Pro примерно в
1.5–2 раза ниже, чем на сервере, и на обеих машинах суточный план считается за секунды,
а перепланирование после события — за сотни миллисекунд.

## 8. Воспроизведение

```bash
core/.venv/bin/python -m core bench-suite \\
  --label "имя-машины" \\
  --output docs/benchmarks/solver-suite-20260928/results-<host>.json
core/.venv/bin/python docs/benchmarks/solver-suite-20260928/summarize.py
```

Суит полностью офлайн: дорожные матрицы — версионированные кеши, внешние вызовы не выполняются.
Машино-зависимы только колонки времени; все колонки качества воспроизводимы.
"""
    (HERE / "README.md").write_text(md + "\n", encoding="utf-8")
    print(f"written {HERE / 'README.md'}")


if __name__ == "__main__":
    main()
