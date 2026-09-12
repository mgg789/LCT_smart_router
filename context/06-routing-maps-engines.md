# Роутинг, геокодинг и карты: движки и данные для РФ (ресерч)

> Ресерч для хакатона ЛЦТ, задача Билайн Бизнес: планирование маршрутов выездных инженеров.
> Упор: self-hosted, работоспособность в РФ без зарубежных API-ключей.
> Факты проверены поиском 2026-09-12; непроверенное помечено «(проверить)».

---

## 1. Что нужно нашему сервису

Задача: десятки заявок на город, 5–20 инженеров, временные окна, SLA, перепланирование.
Технический минимальный набор «гео-примитивов»:

| Примитив | Зачем | Где взять |
|---|---|---|
| Геокодинг (адрес → координаты) | Заявки приходят адресами, инженеры стартуют с адресов/складов | Nominatim (self-host/public), Яндекс Геокодер, 2GIS |
| Матрица времени (инженер×заявка, заявка×заявка) | Алгоритм назначения и последовательности (VRPTW) | OSRM `/table` (рекомендую), Valhalla, GraphHopper, ORS |
| Маршрут + полилиния | Нарисовать маршрут инженера на карте, показать ETA по точкам | OSRM `/route` (geometry=geojson/polyline) |
| Матчинг GPS-трека (опционально) | «Где сейчас инженер» из сырых координат | OSRM `/match` |
| Подложка карты (тайлы) | Отрисовка в веб-UI | OSM-тайлы + Leaflet; резерв — self-host тайлов |
| ETA с учётом времени суток | SLA-прогноз честнее среднего | Исторические коэффициенты по часам (см. §6) |

Важно: координаты везде в порядке **lon,lat** (OSRM, Valhalla) или **lat,lon** (Nominatim, Leaflet) — классический источник багов.

---

## 2. Self-hosted движки (сравнение + рекомендация)

Все четверо едят одни и те же данные OSM (.osm.pbf). Ключевое различие — API, скорость матрицы и память.

| Критерий | **OSRM** | **Valhalla** | **GraphHopper** | **OpenRouteService** |
|---|---|---|---|---|
| Простота поднятия | ★★★ проще всех (3 команды docker) | ★★ автосборка тайлов из pbf в монтируемой папке | ★★ (Java, конфиг профилей) | ★★ (Java, docker-compose, тяжёлый) |
| Скорость /table | **самая быстрая** (CH/MLD) | средняя | быстрая (CH/LM) | средняя |
| Матрица в OSS-версии | да (`/table`) | да (`/sources_to_targets`) | да (Matrix API) | да (`/matrix`) |
| Изохроны | нет | **да** (`/isochrones`) | да | да |
| Динамические стоимости per-request (например, свой профиль грузовика) | нет (пересборка профиля) | **да** (dynamic costing) | частично (custom model, часть в enterprise) | частично |
| Живой трафик из коробки | нет (но есть pipe через `osrm-customize`) | нет (пересборка тайлов) | нет | нет |
| Память на город-миллионник | ~1–2 ГБ (проверить) | ~1–2 ГБ (проверить) | ~2 ГБ (проверить) | прожорлив: ~8–10× размер pbf на профиль (официальные доки ORS; Германия ~25–30 ГБ/профиль) |
| Docker-образ | `ghcr.io/project-osrm/osrm-backend` | `gisops/valhalla` (порт 8002) | `graphhopper/graphhopper` | `openrouteservice/openrouteservice` (порт 8080) |
| Порт по умолчанию | 5000 | 8002 | 8989 | 8080 |

Нюансы:
- **OSRM**: экосистемный стандарт, максимум готовых примеров. Слабые места: нет изохрон, duration — статические (профиль car.lua + `maxspeed` из OSM), поиск «поправок» — только пересборка.
- **Valhalla**: costing-модель задаётся в каждом запросе (`costing: "auto"`, опции `use_highways`, `speed_types` и т.п.), тайловый граф — дёшево обновлять город целиком; изохроны полезны для «зона доезда инженера за 30 мин» — красивая фича для демо.
- **GraphHopper**: matrix и routing в open source, но Route Optimization API (VRP) — платный enterprise. Нам всё равно нужен свой VRPTW-алгоритм, так что не критично.
- **ORS**: самый «жирный» по памяти; хорош, если нужны изохроны + POI в одном флаконе, но для хакатона избыточен.

**Рекомендация: OSRM (MLD) как основной движок** (матрица + полилиния), **Valhalla вторым контейнером опционально** — только ради изохрон, если успеем. Это стандартная связка, минимум рисков, всё работает офлайн.

---

## 3. Пошаговое развёртывание OSRM для российского города

### 3.1 Откуда взять данные OSM (Geofabrik, обновление ежедневно)
- Вся Россия: `https://download.geofabrik.de/russia-latest.osm.pbf` — **3.9 ГБ** (замер 2026-09-12)
- Федеральные округа (замеры 2026-09-12): Центральный **835 МБ**, Приволжский 737 МБ, Северо-Западный 622 МБ, Сибирский 556 МБ, Уральский 376 МБ, Дальневосточный 369 МБ, Южный 298 МБ, Северо-Кавказский 122 МБ, Калининград 27.5 МБ.
  URL вида `https://download.geofabrik.de/russia/central-fed-district-latest.osm.pbf`

### 3.2 Вырезаем город (osmium extract)
Geofabrik делит РФ только по округам, город вырезаем самим:
```bash
sudo apt install osmium-tool          # или docker-образ ghcr.io/osmcode/osmium-tool
# по bbox (примерно Москва; координаты свои — lon_min,lat_min,lon_max,lat_max)
osmium extract --bbox 36.8,55.49,38.05,56.1 \
  central-fed-district-latest.osm.pbf -o moscow.osm.pbf --overwrite
# или по полигону границ города: полигон .poly взять на osm-boundaries.com или overpass
osmium extract --polygon moscow.poly central-fed-district-latest.osm.pbf -o moscow.osm.pbf
```
Для города-миллионника выйдет ~50–300 МБ pbf (проверить) — подготовка минут 2–5.

### 3.3 Подготовка графов (пайплайн MLD, официальный из README osrm-backend)
```bash
mkdir -p osrm-data && cp moscow.osm.pbf osrm-data/city.osm.pbf
docker run -t -v "${PWD}/osrm-data:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/city.osm.pbf
docker run -t -v "${PWD}/osrm-data:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition /data/city.osrm
docker run -t -v "${PWD}/osrm-data:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize /data/city.osrm
```
Для CH (быстрее запросы, дольше подготовка): вместо partition+customize один шаг `osrm-contract`, потом `osrm-routed --algorithm ch`. Для матриц MLD достаточно и пересобирается быстрее.

### 3.4 docker-compose (итоговый сервис)
```yaml
services:
  osrm:
    image: ghcr.io/project-osrm/osrm-backend:latest
    command: osrm-routed --algorithm mld --max-table-size 10000 /data/city.osrm
    volumes: [ "./osrm-data:/data" ]
    ports: [ "5000:5000" ]
    restart: unless-stopped
```
**`--max-table-size`**: дефолт 100 координат на запрос `/table`. Поднимаем флагом при старте `osrm-routed` (это runtime-параметр, подтверждено issues osrm-backend #5830, #2326). У публичного демо-сервера `router.project-osrm.org` лимит жёсткий — ещё одна причина self-host.

### 3.5 curl-примеры
```bash
# Маршрут + полилиния (geometry=geojson удобно для Leaflet; overview=full — вся геометрия)
curl "http://localhost:5000/route/v1/driving/37.6208,55.7539;37.6014,55.7356?overview=full&geometries=geojson&annotations=duration,distance"

# Матрица 3x3: все координаты через ';', порядок lon,lat
curl "http://localhost:5000/table/v1/driving/37.62,55.75;37.50,55.80;37.70,55.72?annotations=duration,distance"

# Матрица «2 источника × 2 цели» (индексы в общий список координат)
curl "http://localhost:5000/table/v1/driving/37.62,55.75;37.50,55.80;37.70,55.72;37.40,55.68?sources=0;1&destinations=2;3&annotations=duration,distance"

# Снап координаты к дороге
curl "http://localhost:5000/nearest/v1/driving/37.62,55.75?number=1"
```
Ответ `/table`: `{"durations": [[i][j] сек], "distances": [[i][j] метры]}`.
Ответ `/route`: `routes[0].duration` (сек), `routes[0].distance` (м), `routes[0].geometry.coordinates` — полилиния.

### 3.6 Как OSRM считает duration (важно для «почему не сходится с реальностью»)
- Трафика в OSRM **нет вообще** (никаких `traffic=true/false`): duration = сумма по сегментам `длина / скорость`, где скорость берётся из профиля `car.lua`: тег `maxspeed` OSM, а при отсутствии — дефолты по классу дороги (motorway 90 км/ч и т.п.).
- На практике city-ETA получается близкой к реальной средней (±10–20%), но заторы и сложные развороты не учитываются; известны жалобы на завышение/занижение на отдельных классах дорог (issue #463).
- Чинить: править `car.lua` (скорости по классам) — быстрая и понятная точка настройки.
- Правильный механизм «как бы трафика»: после `osrm-extract + osrm-partition` прогонять `osrm-customize` с файлом сегментных скоростей (traffic update) — так инжектят реальные скорости без пересборки всего графа (обсуждение osrm-backend #7354). Для хакатона это опционально, см. §6.

---

## 4. Российские облачные API (Яндекс, 2GIS): возможности, цены, лимиты, легальность

### 4.1 Яндекс Геокодер HTTP API
- Формат (v1.x): `GET https://geocode-maps.yandex.ru/1.x/?apikey=KEY&geocode=Москва, Тверская 1&format=json&results=1&lang=ru_RU` → ответ JSON: `response.GeoObjectCollection.featureMember[0].GeoObject.Point.pos` («lon lat»).
- Качество для РФ: эталонное (дома, корпуса, дроби, ТСЖ-топонимика) — Яндекс впереди OSM по полноте адресов.
- Лимиты/цены: бесплатный тариф — **1000 запросов/сутки** (с 01.11.2020 снижено с 25 000; Habr, официальное сообщество Яндекс.Карт). Платно (прайс yandex.ru/maps-api/tariffs, снят 2026-09-12): годовая лицензия **226 200 ₽** (диапазон 1 000–100 000 запросов/сутки), сверх лимита 390 ₽ за 1000; ранее анонсировался малобизнес-тариф ~8 000 ₽/мес за 10 000 запросов (SEOnews, блог Яндекс Вебмастера). **Вывод: дорого → только с кэшем и заранее прогеокодированным демо-датасетом.**

### 4.2 Яндекс Router / Distancer (маршрутизация с пробками)
- Продукты: «API Построения маршрута» (Router, yandex.ru/dev/router — учитывает текущие пробки), «API Матрицы расстояний» (Distancer). Ключ — в Кабинете разработчика.
- Цены: те же 226 200 ₽/год за продукт (2026-09), бесплатное использование «при соблюдении условий бесплатного использования» (некоммерческое, атрибуция).
- **Легальность на хакатоне**: хакатон от крупного бизнеса — формально коммерческое использование; бесплатные квоты для этого серые. Пробки учитываются Router'ом, но **извлекать сырые данные о пробках запрещено условиями** — только визуализация через официальные компоненты. **Рекомендация: не строить критичный путь на Яндекс-роутинге; использовать максимум как демо-фичу «если дадут ключ» с готовым фоллбэком на OSRM.**
- Яндекс Маршрутизация (VRP, courier.yandex.ru) — полноценный платный VRP-сервис, в реестре российского ПО; требует договора — для хакатона не наш путь (и жюри это оценит как «купили готовое»).

### 4.3 2GIS API
- Геокодер: `GET https://catalog.api.2gis.com/3.0/items/geocode?q=<адрес>&fields=items.point&key=KEY`. Дом-уровень по РФ отличный (в примерах доков — корпуса вида «3 ст1», поля FIAS/OKATO/ОКТМО по запросу). Обратный: `?lon=..&lat=..&fields=items.address`.
- Routing API: `POST https://routing.api.2gis.com/routing/7.0.0/global`, демо-ключ (выдаётся в Platform Manager, platform.2gis.ru) — **маршрут не длиннее 50 км**; есть Distance Matrix API и TSP API (docs.2gis.com/api/navigation/*). Учитывает трафик/ограничения по массе-высоте (проверить детали трафика в тарифе).
- Ключи/лимиты: демо-ключ на 30 дней бесплатно; для демо-ключей свои лимиты запросов (docs.2gis.com → «Limits for demo keys», точные числа (проверить)); правило для отдельных юрисдикций — 100 req/s и 50 000 req/сутки на ключ.
- Легальность: ключ по регистрации, коммерческое использование — подписка/договор. Для хакатона демо-ключ обычно ок, но проверяем условия на момент хакатона (проверить).

### 4.4 Сводка «что требует согласования/договора»
| API | Ключ | Бесплатно | Нужен договор? |
|---|---|---|---|
| Яндекс Геокодер | да (Кабинет разработчика) | 1000/сутки | для коммерческого — лицензионный договор |
| Яндекс Router/Distancer | да | «условия бесплатного использования» | да, коммерческое — договор |
| 2GIS Геокодер/Routing | да (Platform Manager) | демо-ключ 30 дней | подписка на постоянку |
| Nominatim public | нет | 1 req/s, не для bulk | нет, но bulk запрещён политикой |
| OSRM/Valhalla self-host | нет | безлимит | нет (OSM-атрибуция обязательна) |

---

## 5. Геокодинг российских адресов: практическая стратегия для хакатона

### 5.1 Качество Nominatim по РФ
- Публичный инстанс `nominatim.openstreetmap.org`: **максимум 1 запрос/сек**, bulk-геокодинг запрещён (политика OSMF), нужен честный `User-Agent`/`Referer` и `email` при серийных запросах; иначе блокировка без предупреждения.
- Качество зависит от полноты `addr:housenumber` в OSM: крупные города РФ покрыты прилично, но:
  - корпуса/дроби (`12к2`, `12/1`, `12А`) — известная проблема парсинга русских номеров домов (Nominatim issue #3171, Stack Overflow о слэшах);
  - частный сектор/новостройки/СТО — часто нет интерполяции → промах;
  - одинаковое название улицы в разных городах → ложное совпадение без `countrycodes` и города в строке.
- Лучшие практики запроса:
```
GET https://nominatim.openstreetmap.org/search?q=Москва, Тверская улица, 1
    &countrycodes=ru&format=jsonv2&limit=1&addressdetails=1
```
  - всегда `countrycodes=ru`; город и тип улицы в тексте запроса («улица»/«ул» — пробовать оба варианта);
  - проверять `type=house`/`building` в ответе: если `type=road` — дом не нашёлся, координата «центр улицы» (плохо, помечать);
  - `viewbox` + `bounded=1` вокруг города — спасает от чужих городов.
- Self-host Nominatim для РФ = импорт России (3.9 ГБ pbf → нужен сервер с ~16+ ГБ RAM, многочасовой импорт) — на хакатоне оверс kill, не берём.

### 5.2 Стратегия для хакатона (главное!)
1. **Заранее прогеокодировать весь демо-датасет** (скриптом с паузой 1.1 сек/запрос к public Nominatim или Яндекс Геокодером — 100–500 адресов влезает в бесплатные лимиты). Сложить в `geocoded.json`: `{адрес: {lat, lon, source, precision}}`.
2. В рантайме — **только кэш** (SQLite/JSON/Redis), никаких онлайн-геокодеров в критическом пути демо.
3. **Fallback-список**: для 10–20 «сложных» адресов (корпуса, промзоны, новостройки) — вручную проставленные координаты из Яндекс.Карт/2GIS. На хакатоне это абсолютно легально и надёжно.
4. Нормализация адресной строки перед геокодингом: убрать «г.», «ул.», дубли региона; для корпуса перебирать варианты `12к2` / `12 к2` / `12/2` / `12А`.
5. 2GIS демо-ключ — лучший резерв: точнее всех бьёт дома РФ (поля FIAS и корпуса из коробки).
6. UI: показывать маркер + адрес и давать редактировать точку перетаскиванием — «честный» workaround, выглядит как фича (уточнение позиции на карте).

---

## 6. Трафик и время в пути: что реально

| Источник | Реально доступен? |
|---|---|
| Яндекс.Пробки | Только внутри официальных API/JS API (Router учитывает пробки; слой пробок в JS API). **Сырые данные третьим лицам не отдаются** (условия использования). |
| 2GIS Routing | Учитывает трафик в своих маршрутах (проверить масштаб покрытия РФ) — но опять же «чёрный ящик», сырых скоростей нет. |
| TomTom Traffic | **Отключён для РФ с мая 2022** (TomTom приостановил операции в РФ и выключил live traffic — leave-russia.org). |
| HERE | Официального подтверждения доступности РФ-трафика нет; компания под санкционным режимом EU — считаем недоступным (проверить). |
| Google | Новые ключи РФ не выдаются — недоступен. |
| OSRM/Valhalla/ORS | Трафика нет by design; только статические скорости OSM. |

**Честный вариант для хакатона:**
1. База — матрица OSRM (статические скорости, «свободный поток»).
2. Time-dependent ETA: таблица коэффициентов скорости по часам (исторические средние, задаём руками для города-демо):
```python
# доля от «свободной» скорости: ночь 1.0, час пик 0.55, межпик 0.8
HOURLY_FACTOR = {0:1.0, 7:0.55, 8:0.55, 9:0.7, 12:0.8, 17:0.6, 18:0.6, 19:0.75, 23:0.9, ...}
eta = base_duration / HOURLY_FACTOR[departure_hour]
```
3. В презентации прямо говорить: «ETA = свободный поток × исторические коэффициенты загруженности по часам; подключение живого трафика в РФ юридически возможно только через Яндекс/2GIS по договору — архитектурно готово (свой провайдер ETA)». Для жюри это плюс, а не минус: показываем знание предметной области.
4. Опционально для «вау»: перегенерация матрицы через `osrm-customize` с файлом сегментных скоростей (пайплайн описан в §3.6) — показать «трафик обновился, план пересчитан». Это делается раз в минуты, не по запросу — для демо перепланирования подходит.

---

## 7. Матрица расстояний: размеры, кэш, производительность

Наш масштаб: ~20–100 заявок + 5–20 инженеров → **матрица максимум ~120×120 = 14 400 пар**.
- Один запрос `/table` со 120 точками проходит при `--max-table-size 10000`; на городском графе MLD ответ приходит за **десятки–сотни миллисекунд** (проверить точное время на нашем железе; на матрицах OSRM стабильно быстрее Valhalla/GH — LogisticsOS, общие бенчмарки).
- Если не поднимать лимит: дробить запросы батчами по ≤100 координат (120 точек = 2 батча по sources/destinations) — код ниже.
- **Кэширование — главный оптимизационный приём**: точки (склады+заявки) почти не меняются весь день → считаем матрицу один раз утром, храним в памяти (14 400×2 float — это ~230 КБ!) или Redis. Новая заявка → инкрементально: `/table` с `sources=новая точка, destinations=все` (и наоборот) — строки/столбцы дописываются. Перепланирование тогда не упирается в сеть вообще.
- Для VRPTW-алгоритма: работать в единицах времени (сек) из `durations`; `distances` держать для UI/биллинга км.

### Python-сниппет (получение матрицы с OSRM)
```python
import requests

OSRM = "http://localhost:5000"

def matrix(coords, annotations="duration,distance", batch=90):
    """coords: [(lon, lat), ...]; вернёт (durations, distances) full NxN."""
    n = len(coords)
    D = [[0.0]*n for _ in range(n)]
    M = [[0.0]*n for _ in range(n)]
    for s0 in range(0, n, batch):
        src = list(range(s0, min(s0+batch, n)))
        r = requests.get(f"{OSRM}/table/v1/driving/{';'.join(f'{x},{y}' for x,y in coords)}",
                         params={"sources": ";".join(map(str, src)),
                                 "destinations": ";".join(map(str, range(n))),
                                 "annotations": annotations}, timeout=30).json()
        if r.get("code") != "Ok":
            raise RuntimeError(r)
        for i, si in enumerate(src):
            D[si] = r["durations"][i]; M[si] = r["distances"][i]
    return D, M

if __name__ == "__main__":
    pts = [(37.6208, 55.7539), (37.5034, 55.7903), (37.7021, 55.7181)]  # lon, lat!
    d, m = matrix(pts)
    print(d[0][1], "сек;", m[0][1], "м")
```
(при `--max-table-size 10000` параметр `batch` можно поднять и звать один раз без `sources`).

---

## 8. Риски и запасные варианты (офлайн-план)

| Риск | Митигирование |
|---|---|
| Нет интернета на демо-стенде | Всё в docker на своём ноутбуке: OSRM (готовый `city.osrm`), тайлы OSM кэшированы, геокодинг — только кэш. Полная офлайн-работоспособность. |
| Медленное подготовка pbf / не хватит памяти | Вырезать город osmium заранее; pbf города ~50–300 МБ, OSRM-подготовка минуты; держать готовый артефакт в репо/LFS. |
| Геокодер недоступен/врёт | Кэш + ручные координаты для сложных точек (§5.2). |
| «А где пробки?» от жюри | Ответ из §6: юридическая недоступность сырых данных в РФ + time-dependent коэффициенты + готовая точка расширения провайдером ETA. |
| OSRM кладёт не туда точку (снап) | `/nearest` для отладки; фильтр по расстоянию снапа (>200 м — подозрительно, пометить в UI). |
| Полилиния «не той системе» | OSRM отдаёт lon,lat; Leaflet ждёт lat,lon — единый хелпер конвертации. `geometries=geojson` проще, чем декодить polyline. |
| Тайлы OSM (tile.openstreetmap.org) при нагрузке | Для демо ок; политика запрещает агрессивный bulk — self-host тайлов (tileserver-gl + pbf → mbtiles, Protomaps) как резерв (проверить при необходимости). |
| Утечка «мы использовали платный API без договора» | Основной путь — 100% open data (OSM/Geofabrik) + self-host. Облачные РФ-API — только как опциональное демо-сравнение. |

Атрибуция: обязательна для OSM-данных («© OpenStreetMap contributors») — поставить в футер карты, это и есть правильное использование.

---

## 9. Источники

**OSRM**
- OSRM README (docker, пайплайн extract/partition/customize, сервисы, порт 5000): https://github.com/Project-OSRM/osrm-backend
- Повышение лимита `/table` (--max-table-size): https://stackoverflow.com/questions/75877275/how-to-change-osrm-table-query-limit ; https://github.com/Project-OSRM/osrm-backend/issues/5830 ; https://github.com/Project-OSRM/osrm-backend/issues/2326
- Профили/скорости: https://project-osrm.org/docs/v26.4.0/profiles ; issue о неточности durations: https://github.com/Project-OSRM/osrm-backend/issues/463
- Инжект скоростей через osrm-customize: https://github.com/Project-OSRM/osrm-backend/discussions/7354
- Нет live-трафика в OSRM: https://stadiamaps.com/blog/why-osm-routing-needs-real-time-traffic/

**Данные OSM**
- Geofabrik Россия + размеры (3.9 ГБ, округа): https://download.geofabrik.de/russia.html ; https://download.geofabrik.de/russia/central-fed-district.html
- osmium extract: https://osm-boundaries.com ; https://gis.stackexchange.com/questions/360205/

**Valhalla / GraphHopper / ORS**
- Матрица Valhalla: https://valhalla.github.io/valhalla/api/matrix/ ; docker gisops: https://github.com/gis-ops/docker-valhalla ; обзор фич: https://valhalla.github.io/valhalla/
- Сравнение скорости матриц OSRM vs Valhalla: https://www.logisticsos.com/blog/distance-matrix
- GraphHopper OSS vs enterprise: https://www.graphhopper.com/open-source/ ; https://www.graphhopper.com/faq/difference-directions-api-open-source/
- ORS требования к памяти: https://giscience.github.io/openrouteservice/run-instance/system-requirements ; образ: https://hub.docker.com/r/openrouteservice/openrouteservice
- Обсуждение GH vs ORS: https://ask.openrouteservice.org/t/graphhopper-vs-ors/4743

**Яндекс**
- Тарифы API Яндекс Карт (снято 2026-09-12): https://yandex.ru/maps-api/tariffs ; продукт Геокодер: https://yandex.ru/maps-api/products/geocoder-api
- Лимит геокодера 1000/сут (с 01.11.2020): https://habr.com/ru/articles/534488/ ; малобизнес-тариф 8000 ₽/мес: https://webmaster.yandex.ru/blog/u-api-yandeks-kart-poyavilsya-tarif-dlya-malogo-biznesa
- Router API (детали маршрута): https://yandex.ru/dev/router/doc/ru/
- Запрет выноса слоя пробок: https://habr.com/ru/articles/86857/

**2GIS**
- Геокодер: https://docs.2gis.com/en/api/search/geocoder/overview
- Routing (демо-ключ, 50 км): https://docs.2gis.com/api/navigation/routing/start
- Ключи/лимиты: https://docs.2gis.com/en/platform-manager/subscription/keys ; https://platform.2gis.ru/tariffs

**Геокодинг РФ / Nominatim**
- Политика использования: https://operations.osmfoundation.org/policies/nominatim/
- Search API (countrycodes): https://nominatim.org/release-docs/latest/api/Search/
- Русские номера домов: https://github.com/osm-search/Nominatim/issues/3171 ; https://stackoverflow.com/questions/47641197/openstreetmap-nominatim-slash-in-housenumber

**Трафик**
- TomTom приостановка РФ и отключение live traffic (май 2022): https://leave-russia.org/tomtom
- Санкционный контекст: https://www.consilium.europa.eu/en/policies/sanctions-against-russia/
