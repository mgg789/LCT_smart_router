# Каноническая сериализация `RouterTaskSnapshot`

> Общий контракт System Layer (TypeScript) и Router Core (Python).
> Реализация: [`apps/api/src/common/json/canonical-json.ts`](../../apps/api/src/common/json/canonical-json.ts).
> Канон: `context/33` §4 и §7, `context/43` §5.2.

## Зачем этот документ

`input_hash` считается **независимо** на двух сторонах: System Layer хэширует
публикуемый им документ, Router Core — прочитанный им документ. Результат применяется,
только когда значения совпали (`context/33` §7). Если сериализаторы различаются хотя
бы на байт, hash-и никогда не совпадут, каждый результат отклоняется как принадлежащий
чужому снимку, и контур тихо перестаёт применять планы, пока все компоненты рапортуют
о здоровье.

`JSON.stringify` и `json.dumps` взаимозаменяемы не полностью. Они согласны в синтаксисе
объектов и строк и расходятся в числах: JavaScript печатает `55` для значения `55.0`,
где Python печатает `55.0`, и они переходят в экспоненциальную запись при разных
порядках. Правила ниже снимают эту свободу.

## Правила

1. **Ключи объектов сортируются** по возрастанию кодовой единицы UTF-16 — сравнение
   строк по умолчанию в JavaScript и `sorted()` над `str` в Python.
2. **Никаких пробелов**: `{"a":1,"b":[2,3]}`.
3. **Строки** — стандартный JSON-экранирование. Не-ASCII символы **не** экранируются;
   вывод — UTF-8. В Python это `ensure_ascii=False`.
4. **Число, являющееся целым**, пишется без десятичной точки: `1789459200`. Значение
   `55.0` — целое и пишется `55`.
5. **Любое другое число** пишется **ровно с семью знаками после запятой**: `55.7600000`.
   В Python — `format(value, '.7f')`. Семь знаков выбраны под географические координаты:
   это около сантиметра — намного точнее любого маршрутного решения.
6. `true`, `false` и `null` пишутся литерально.
7. **Массивы сохраняют порядок.** Порядок несёт смысл: `arrival_order` и `input_order`
   задают baseline и никогда не пересортировываются (`context/33` §5).
8. **Отклоняется, не приводится:** `undefined`, `NaN`, бесконечности, даты, функции.
   Отсутствующее значение — явный `null`: «поля не было» и «значение неизвестно» —
   разные утверждения (`context/33` §4).
9. **`bigint` отклоняется.** Граница чтения конвертирует его в number первым, чтобы
   одно значение не сериализовалось двумя способами.

`input_hash` — `sha256(canonical_bytes)` строчными hex. Хэш хранится **рядом** с
документом и никогда внутри него: хэш не может быть частью собственного входа.

Документ сериализуется один раз, и одна и та же строка и хранится, и хэшируется.
Пересериализация ради хэша оставила бы двум копиям шанс разойтись.

## Эталонная реализация (Python)

Это сторона Router Core. Она производит байт-в-байт идентичный вывод с реализацией
TypeScript для вектора ниже — проверено, не предположено.

```python
import hashlib
import json


def canonical(value, path="$"):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("not representable at " + path)
        if value.is_integer():
            return str(int(value))
        return format(value, ".7f")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v, f"{path}[{i}]") for i, v in enumerate(value)) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + canonical(v, f"{path}.{k}")
            for k, v in items
        ) + "}"
    raise ValueError(f"unsupported {type(value)} at {path}")


def input_hash(document) -> str:
    return hashlib.sha256(canonical(document).encode("utf-8")).hexdigest()
```

Обратите внимание: проверки `bool` стоят перед проверкой `int` — в Python `True` **есть**
`int`, и без этого порядка булево значение сериализовалось бы как `1`.

## Golden-вектор

| Файл | Что это |
|---|---|
| [`fixtures/snapshot-golden.json`](./fixtures/snapshot-golden.json) | Входной документ, нарочно записанный с отступами и несортированными ключами |
| [`fixtures/snapshot-golden.canonical.txt`](./fixtures/snapshot-golden.canonical.txt) | Точные канонические байты (1545 байт), хранятся с одним завершающим переводом строки для читаемости |
| [`fixtures/snapshot-golden.sha256.txt`](./fixtures/snapshot-golden.sha256.txt) | Ожидаемый дайджест |

```
23e170a1c8b0fe41d4b630ebd9421907c2cb99d97edeb7476914e569d7432595
```

Вектор нарочно содержит случаи, ломающие наивные реализации: координату с целым
значением (`55.0`), координату с более чем семью значащими знаками, `null` в каждом
nullable-поле, `lunch_taken` в true и false, пустой объект `parameters` и вложенные
объекты с ключами не по алфавиту.

**Обе стороны обязаны воспроизводить эти байты.**
`apps/api/test/unit/canonical-json.test.ts` проверяет это для TypeScript; Router Core
должен проверить тот же файл в своём наборе. Падение здесь — раннее предупреждение
симптома, который иначе выглядит как «Router считает, но план никогда не применяется».

## Что нарочно отсутствует в снимке

Текст проблемы клиента, имена и адреса; история исполнения; вычисленный ETA; дорожная
матрица; внутренний допуск; карта. Это либо собственные бизнес-данные System Layer,
либо отдельно подключаемые ресурсы Router (`context/33` §3). Хэш покрывает задачу и
ничего больше, поэтому посторонняя активность не инвалидирует результат.
