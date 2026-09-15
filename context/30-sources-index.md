# Сводный индекс источников

> Назначение: все источники ресерча в одном месте, сгруппированы по темам, с пометкой «что подтверждает». Дата сбора: 2026-09-12. При использовании факта в коде/презентации — ссылаться на первоисточник отсюда.

---

## 1. Хакатон ЛЦТ 2026 и кейс Билайн (→ `17`, `26`)

| Источник | Что подтверждает |
|---|---|
| [i.moscow/lct — оф. страница ЛЦТ](https://i.moscow/lct) | Таймлайн (разработка 15–29.09, экспертиза 30.09–14.10, финал 23.10), фонд 40 млн ₽, отбор 10 команд/задачу, правила |
| [ComNews: участники ЛЦТ создадут цифровые решения для бизнеса (28.07.2026)](https://www.comnews.ru/content/246601/2026-07-28/2026-w31/1018/uchastniki-khakatona-lidery-cifrovoy-transformacii-sozdadut-cifrovye-resheniya-dlya-biznesa) | Кейс билайн бизнес дословно, состав заказчиков |
| [Habr: «Мы делали продукт, они — презентацию»](https://habr.com/ru/articles/964670/) | Критерии из Положения (5 критериев × 5 баллов), практика оценивания 2025 |
| [Habr: официальный блог ЛЦТ — подготовка](https://habr.com/en/companies/leadersofdigital/articles/449516/) | Советы организаторов |
| [rskrf.ru о старте ЛЦТ](https://rskrf.ru/news/startoval-priem-zayavok-na-khakaton-mera-moskvy-lidery-tsifrovoy-transformatsii/) | Призы (1/0.6/0.4 млн ₽), условия участия |
| [moskva.beeline.ru/business — интернет для бизнеса](https://moskva.beeline.ru/business/office-internet/internet-v-ofis/), [облачное видеонаблюдение](https://moskva.beeline.ru/business/cloud-services/videonablyudenie/) | Продукты билайн бизнес (контекст домена) |

## 2. Солверы, алгоритмы, динамика (→ `04`, `05`, `07`)

| Источник | Что подтверждает |
|---|---|
| [OR-Tools Routing docs](https://developers.google.com/optimization/routing) | API модели, стратегии, лимиты |
| [OR-Tools: Common Routing Tasks](https://developers.google.com/optimization/routing/routing_tasks) | Warm start (`ReadAssignmentFromRoutes`/`SolveFromAssignmentWithParameters`) |
| [Google Research: OR-Tools VRP solver (2023)](https://research.google/pubs/or-tools-vehicle-routing-solver-a-generic-constraint-programming-solver-with-heuristic-search-for-routing-problems/) | Архитектура солвера (first solution + local search) |
| [Timefold Solver Python — GitHub](https://github.com/TimefoldAI/timefold-solver-python), [PyPI](https://pypi.org/project/timefold-solver/), [анонс](https://timefold.ai/blog/new-open-source-solver-python) | Python-версия, real-time planning |
| [VROOM — GitHub](https://github.com/vroom-project/vroom), [vroom-project.org](http://vroom-project.org/) | C++ солвер, skills/TW, миллисекунды |
| [PyVRP docs](https://pyvrp.org/) | HGS, поддерживаемые варианты, отсутствие skills |
| [Pillac et al. 2013 — обзор DVRP (HAL)](https://hal.science/hal-00739779/document) | Таксономия динамического VRP |
| [Обзор DVRP со случайными заявками (2022)](https://research.tue.nl/files/257489379/1_s2.0_S0925527322003334_main.pdf), [Larsen, DTU](https://core.ac.uk/download/pdf/13737995.pdf), [CIRRELT-2019-45](https://www.cirrelt.ca/documentstravail/cirrelt-2019-45.pdf) | Динамика, time-dependent, стабильность планов |
| [OR StackExchange: warm start CVRP](https://or.stackexchange.com/questions/8288/how-does-or-tools-improve-on-an-initial-solution-to-cvrp), [or-tools-discuss о search-параметрах](https://groups.google.com/g/or-tools-discuss/c/ousalyiYpwc) | Нюансы тёплого старта |

## 3. ML/AI (→ `08`)

| Источник | Что подтверждает |
|---|---|
| [ReEvo (NeurIPS 2024) — OpenReview](https://openreview.net/forum?id=483IPG0HWL), [GitHub ai4co/reevo](https://github.com/ai4co/reevo) | LLM-гиперэвристики (направление, не берём) |
| [LLMs for CO — систематический обзор (ACM 2026)](https://dl.acm.org/doi/10.1145/3801961), [arXiv:2509.08269](https://arxiv.org/html/2509.08269v1) | Карта LLM×оптимизация |
| [faster-whisper — GitHub](https://github.com/SYSTRAN/faster-whisper) | 4× быстрее на GPU, локальный русский ASR |

## 4. Карты, пробки, геокодинг (→ `06`, `20`)

| Источник | Что подтверждает |
|---|---|
| [Yandex Tiles API](https://yandex.ru/maps-api/products/tiles-api), [новость о бесплатности](https://habr.com/ru/news/919698/), [TAdviser](https://www.tadviser.com/index.php/Product:Yandex_Maps_API), [тарифы API](https://yandex.ru/maps-api/tariffs) | Бесплатная подложка (с 03.06.2025), платность остальных сервисов |
| [2GIS Routing API — обзор](https://docs.2gis.com/api/navigation/routing/overview), [Directions](https://docs.2gis.com/api/navigation/directions/overview), [Pairs](https://docs.2gis.com/api/navigation/pairs/overview), [Distance Matrix](https://docs.2gis.com/api/navigation/distance-matrix/start), [TSP](https://docs.2gis.com/api/navigation/tsp/overview), [начало работы](https://docs.2gis.com/api/navigation/routing/start) | Трафик в расчёте, демо-ключи, TSP API |
| [CARTO Basemaps](https://carto.com/basemaps/), [FAQ](https://docs.carto.com/faqs/carto-basemaps), [стили на GitHub](https://github.com/cartodb/basemap-styles) | 5 млн тайлов/мес бесплатно, MapLibre-совместимость |
| [MapTiler pricing](https://www.maptiler.com/cloud/pricing/) | Лимиты free-плана |
| [OSRM docs / проект](https://project-osrm.org/), [Geofabrik Russia](https://download.geofabrik.de/europe/russia.html) | Self-host, выгрузки .osm.pbf |
| [Habr: слой пробок на Яндекс.Карте (2011)](https://habr.com/ru/articles/86857/) | Только как «так не делаем» (ToS) |

## 5. Открытые данные Москвы, погода, календарь (→ `22`, `21`)

| Источник | Что подтверждает |
|---|---|
| [data.mos.ru](https://data.mos.ru/), [документация API](https://data.mos.ru/developers/documentation), [песочница](https://data.mos.ru/developers/useApi) | Формат apidata.mos.ru, бесплатный ключ |
| [Набор «Парковки» №623](https://data.mos.ru/opendata/623), [parking.mos.ru](https://parking.mos.ru/) | Парковочные данные |
| [DataCrafter: зоны платной парковки](https://data.apicrafter.ru/packages/datamos-paidparkingzones), [ЭЗС](https://data.apicrafter.ru/packages/datamos-chargingelectricstations), [график отключений горячей воды](https://data.apicrafter.ru/tables/datamos/hotwaterschedule) | Существование наборов и их поля |
| [Карта перекрытий ЕТП](https://transport.mos.ru/mostrans/closures) | Перекрытия/ограничения (витрина) |
| [МОЭК Онлайн](https://online.moek.ru/hotwater), [mos.ru: график отключений](https://www.mos.ru/otvet-dom-i-dvor/grafik-otklucheniya-goryachei-vodi/) | Официальные проверки отключений (API нет) |
| [Open-Meteo](https://open-meteo.com/), [docs](https://open-meteo.com/en/docs), [pricing](https://open-meteo.com/en/pricing) | Бесплатно без ключа, 10k/день, некоммерческое |
| [isdayoff.ru](https://www.isdayoff.ru/), [Python-обёртка](https://github.com/KlukvaMors/isdayoff), [calendar.kuzyak.in](https://calendar.kuzyak.in/) | Производственный календарь API |
| [Overpass by Example (OSM wiki)](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_API_by_Example), [bbox docs](https://dev.overpass-api.de/overpass-doc/en/full_data/bbox.html), [рецепты Python](https://janakiev.com/blog/openstreetmap-with-python-and-overpass-api/), [Overpass Turbo](https://overpass-turbo.eu/) | Запросы АЗС/кафе/парковок |

## 6. АЗС, очереди (→ `21`)

| Источник | Что подтверждает |
|---|---|
| [ТАСС: Яндекс открыл карту топлива и очередей](https://tass.ru/ekonomika/27899331), [новость Яндекса](https://yandex.ru/company/news/17-07-2026-01), [Expert.ru](https://expert.ru/news/yandeks-nachal-pokazyvat-nalichie-ocheredey-na-azs-v-moskve-i-peterburge) | Очереди видны в приложениях (июль 2026), API нет |
| [Ликоард: наличие топлива в прил. ЛУКОЙЛ](https://licard.ru/ru/News/News/proverte-nalichie-topliva-v-mobilnom-prilozhenii), [карта АЗС Газпромнефть](https://gpnbonus.ru/fuel/refuel-map) | Сети показывают статус самих АЗС |

## 7. Коммуникации (→ `23`)

| Источник | Что подтверждает |
|---|---|
| [Exolve тарифы](https://exolve.ru/tariffs/api/messengers/), [изменения тарифов](https://exolve.ru/news/izmenenie-tarifov-po-usluge-sms-rassylka-v-ramkakh-proekta-api-platforma-mtc-exolve/) | 7,50 ₽ на сеть Билайн, абонплата за шаблоны с 2026 |
| [SMSAero цены](https://smsaero.ru/price/sms/), [SMS.ru API](https://sms.ru/api) / [цены](https://sms.ru/price), [МТС OmniChannel](https://omnichannel.mts.ru/sms) | Диапазон цен, API |
| [Telegram Bot API](https://core.telegram.org/bots/api) | Бесплатный канал, кнопки/callback |

## 8. Голос, календари (→ `24`)

| Источник | Что подтверждает |
|---|---|
| [MDN Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API), [Chrome 139 on-device](https://developer.chrome.com/blog/new-in-chrome-139), [explainer языков](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md) | ru-RU только облако; локальный режим без русского |
| [ical-generator (npm)](https://github.com/sebbo2002/ical-generator) | Генерация .ics-фидов |

## 9. Аналоги рынка (→ `03`)

| Источник | Что подтверждает |
|---|---|
| [OptimoRoute help: таймлайн-модификация](https://help.optimoroute.com/hc/en-us/articles/27804856390420-Manually-schedule-and-modify-orders-on-routes), [best-fit DnD](https://help.optimoroute.com/hc/en-us/articles/27804746215828-Plan-with-best-fit-drag-and-drop) | DnD-паттерны |
| [Route4Me dynamic re-optimization](https://route4me.com/tv/platform/route-optimization-software/dynamic-route-optimization), [field services](https://route4me.com/solutions/facility-and-property-services-routing-software) | Skills/equipment routing, 5000 заказов |
| [Routific vs OptimoRoute](https://www.routific.com/blog/optimoroute-vs-routific), [RFP.wiki](https://www.rfp.wiki/supply-chain-logistics-transportation/transportation-management-systems/vehicle-routing-scheduling/route4me/routific) | Сравнения и модели ценообразования |
| [Планадо](https://planado.ru/), [отзывы](https://planado.ru/otzyvy) | Российский FSM: наряды, GPS, интеграции |
| [Маппа](https://mappa-logistics.ru/mobile-team), [ШЕДЕКС](https://schedex.ru/), [Logist Uno](https://logist.uno/programma-dlya-upravleniya-mobilnymi-sotrudnikami), [ANTOR RouteMaster](https://reestr.digital.gov.ru/reestr/745583/), [Hubex](https://hubex.ru/statyi/tpost/56spfr2fd1-kak-planirovanie-viezdnogo-obsluzhaniy), [подборка picktech](https://picktech.ru/catalog/route-planning-software/) | Российский рынок маршрутизации |

## 10. UX-референсы (→ `10`)

Beeline sources checked on 2026-09-15: [official Yellowbe page](https://moskva.beeline.ru/business/beeline-prodvizhenie/yellowbe/) and its two public PDF documents. The [local reference pack](../docs/design/beeline/README.md) contains unchanged PDFs, the official website symbol, extracted website colour declarations and a SHA-256 manifest. This is platform documentation and website evidence, not a complete current brandbook; Smart Router UI choices are labelled separately.

Apple Human Interface Guidelines (developer.apple.com/design), Apple Maps, Linear (linear.app), Notion Calendar, Uber/Lyft dispatch-обзоры — визуальные паттерны, не факты.

---

Правило жизни индекса: новый источник добавляй в тему и рядом с фактом в файле, где он используется. Мёртвые ссылки чистить при следующем обновлении контекста.
