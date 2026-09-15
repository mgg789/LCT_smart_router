# B. Рыночно-доменное исследование: FSM и планирование маршрутов выездных инженеров

**Контекст:** хакатон ЛЦТ-2026, кейс «Билайн Бизнес» — веб-сервис планирования рабочих маршрутов выездных инженеров (Field Service Management + VRPTW) с картой, перепланированием и объяснением решений диспетчеру.
**Автор:** продуктовая аналитика команды.
**Дата сбора:** сентябрь 2026.

**Как читать документ.**
- 🔵 **ФАКТ** — утверждение взято из внешнего источника, рядом стоит ссылка.
- 🟡 **ГИПОТЕЗА** — наш вывод/интерпретация, источником напрямую не подтверждён.
- Все ссылки собраны в разделе 10.

---

## 0. TL;DR — 12 главных выводов

1. 🔵 Рынок FSM-софта — ~5,1 млрд USD в 2025 с прогнозом ~9,2 млрд USD к 2030 (CAGR ~12,5%); это зрелый рынок с отлаженными UX-паттернами, которые можно и нужно копировать. ([MarketsandMarkets](https://www.marketsandmarkets.com/PressReleases/field-service-management.asp))
2. 🔵 Все промышленные системы устроены по одной схеме: **«жёсткие ограничения» (constraints / work rules) отсеивают кандидатов, «мягкие цели» (objectives) ранжируют варианты**. Формулировка Salesforce: «если требование — *must*, это work rule; если *prefer* — это objective». ([Salesforce Help](https://help.salesforce.com/s/articleView?id=service.pfs_optimization_theory_work_rules_service_resource_availability.htm&language=en_US&type=5))
3. 🔵 Microsoft RSO публикует **полный список ограничений и целей** — это готовый чек-лист модели данных для нашего прототипа (см. 2.2). ([Microsoft Learn](https://learn.microsoft.com/en-us/dynamics365/field-service/rso-optimization-goal))
4. 🔵 Ключевой доменный термин, который почти никто из хакатонных команд не знает — **jeopardy**: «ситуация jeopardy означает, что работа не уложится в обещанное окно обслуживания». У Oracle такие визиты подсвечиваются розовым, у Salesforce — красным. ([Oracle](https://docs.oracle.com/en/cloud/saas/field-service/faaca/t-identifyJeopardySituations.html))
5. 🔵 Метрики домена, на которых строится ценностное предложение: **first-time fix rate** (лучшие — 85%+), **utilization** (норма 75–80%), **travel time ratio** (best-in-class < 20–25%, ручная диспетчеризация — 35–40%). ([ServiceTitan](https://www.servicetitan.com/blog/field-service-metrics), [NetSuite](https://www.netsuite.com/portal/resource/articles/erp/field-services-kpis-metrics.shtml), [FieldPie](https://www.fieldpie.com/blog/technician-travel-time-optimization/))
6. 🔵 Индустриальный бенчмарк эффекта: внедрение оптимизации даёт **−10…−40% времени в пути** и **+25–50% к on-time performance**. Это цифры, которые можно использовать в питче как «ожидаемый эффект». ([FieldPie](https://www.fieldpie.com/blog/technician-travel-time-optimization/))
7. 🔵 Объяснимость в индустрии решается тремя приёмами: **constraint-based** («не подошёл — нет навыка»), **contrastive** («почему не Анна?») и **counterfactual** («что изменить, чтобы это сделала Анна?»). У DecisionBrain есть готовые шаблоны формулировок. ([DecisionBrain](https://decisionbrain.com/combinatorial-optimization/))
8. 🔵 Академический стандарт объяснения VRP — **why / why-not вопросы через контрфактический маршрут**: фиксируем префикс маршрута, подставляем альтернативное ребро, дорешиваем, сравниваем метрики. Это ровно то, что мы можем реализовать за хакатон. ([RouteExplainer, arXiv:2403.03585](https://ar5iv.labs.arxiv.org/html/2403.03585))
9. 🔵 Timefold/OptaPlanner дают инженерный образец структуры объяснения: `ScoreAnalysis` → вклад по каждому ограничению → `ConstraintMatch` с `justification` → `Indictment` (кто виноват). Это наш формат API объяснений. ([Timefold](https://timefold.ai/blog/timefold-solver-1-4-brings-explainable-score))
10. 🔵 Все дисп-панели построены по одному layout'у: **список заявок ↔ карта ↔ гант по исполнителям**, с панелью нераспределённых работ и drag&drop. Это не «наша выдумка», а отраслевой стандарт — жюри узнает его мгновенно.
11. 🟡 Наша дифференциация на хакатоне — не качество солвера (его за 36 часов не обогнать), а **связка «объяснение + перепланирование + diff плана»**, которой у большинства систем нет в явном виде.
12. 🔵 Нераспределённые заявки — отдельная первоклассная сущность во всех API: у Skedulo это массив `unscheduled` в ответе, у OR-Tools — механизм `AddDisjunction` с штрафом за пропуск точки, у Oracle — «Consolidated Unassigned Activity Report» с «non-assignment reasons». ([Skedulo](https://docs.skedulo.com/developer-guides/manage-and-schedule-work/optimization-of-schedules/optimize-vs-suggest/optimized-scheduling-using-the-api/), [OR-Tools](https://developers.google.com/optimization/routing/penalties), [Oracle](https://docs.oracle.com/en/cloud/saas/field-service/farcu/c-routing-runs.html))

---

## 1. Домен: Field Service Management

### 1.1. Что такое FSM

🔵 Field Service Management — «управление ресурсами компании, задействованными у клиента или в пути к клиенту, а не на территории компании». Применяется там, где есть «установка, обслуживание или ремонт систем и оборудования»; телеком и прокладка кабеля названы одной из ключевых отраслей применения. ([Wikipedia: Field service management](https://en.wikipedia.org/wiki/Field_service_management))

🔵 Функциональное ядро FSM по тому же источнику: определение местоположения техники и активности сотрудников; планирование и диспетчеризация заданий; безопасность водителей; интеграция с бэк-офисом (склад, биллинг, учёт).

🔵 Русскоязычная отраслевая формулировка: «под выездным сервисным обслуживанием понимается любая сервисная работа, выполняемая на объекте клиента, а не в главном офисе компании»; FSM отличается от HelpDesk/ServiceDesk тем, что решает не только обработку заявок, но и графики, перемещения, SLA. ([HubEx](https://hubex.ru/blog/tpost/r5d2psmku1-upravlenie-viezdnim-obsluzhivaniem-fsm-z), [SNRD](https://snrd.ru/blog/chto-takoe-field-service-management/))

### 1.2. День выездного инженера у телеком-оператора

🔵 Из описания реальной работы телеком-инженера: значительная часть дня — реакция на неожиданные аварийные сигналы (alarms) с площадок; обязанности — «установка, тестирование и обслуживание оборудования», включая установку роутеров и коммутаторов. ([Medium: Day in the Life of a Field Service Engineer working in Telecom](https://medium.com/@michaelakpoteheri36987/day-in-the-life-of-a-field-service-engineer-working-in-telecom-bac56d8bc060), [FieldEngineer](https://www.fieldengineer.com/skills/field-engineer))

🟡 **Реконструкция типового дня** (наша модель, собранная из описаний систем — важна для дизайна прототипа):

| Этап | Что происходит | Что это значит для модели данных |
|---|---|---|
| 07:30–08:00 | Старт смены: инженер выезжает из дома или из склада/депо | У ресурса есть `start_location` и `end_location` (не обязательно одна точка) — у Microsoft это прямо «travel time from the last booking to the resource's end location» |
| 08:00 | Открывает мобильное приложение, видит маршрут на день | План — упорядоченная последовательность визитов с ожидаемым временем прибытия |
| В течение дня | 4–8 визитов: подключение/настройка/ремонт; между ними — дорога | Визит = `service_time` (длительность на месте) + `travel_time` (дорога) |
| Обед | Фиксированный или плавающий перерыв | Break как ограничение в смене |
| Срыв | Клиента нет на месте, работа заняла вдвое дольше, авария высокого приоритета | Триггер **перепланирования дня** — ключевой сценарий нашего демо |
| Конец дня | Закрытие нарядов, возврат неиспользованных ЗИП | Статусная модель заявки |

### 1.3. Роль диспетчера

🔵 «Основная задача диспетчера — назначить правильный ресурс на правильную работу в правильное время, при этом держа клиента в курсе и сохраняя загрузку активов». Диспетчеры принимают звонки от инженеров, корректируют работы под изменения клиента, исправляют ошибки, закрывают наряды, звонят клиентам для подтверждения или переноса визита. ([Assessment.com: Dispatchers Career Guide](https://www.assessment.com/office-and-administrative-support-careers/dispatchers-career-guide), [NetSuite: What Is Field Service Dispatching?](https://www.netsuite.com/portal/resource/articles/erp/field-service-dispatching.shtml))

🔵 IFS формулирует целевую модель работы диспетчера в системе с оптимизацией: «непрерывная оптимизация, использующая 35 различных алгоритмов и AI-отбор, автоматически справляется с большей частью сложности расписания, позволяя диспетчерам сосредоточиться преимущественно на высокоценных исключениях». ([Gogh Solutions об IFS PSO](https://goghsolutions.com/ifs-pso/))

🟡 **Продуктовый вывод:** диспетчер — не «оператор, который расставляет заявки», а **exception manager**. Значит UI должен по умолчанию показывать не «весь план», а «что сломалось»: нераспределённые заявки, конфликты, визиты в jeopardy. Автоплан должен быть фоном, исключения — на переднем плане.

### 1.4. SLA-окно визита (appointment / service window)

🔵 Промышленный стандарт — у заявки есть несколько разных временных полей, и они не одно и то же. Наиболее явно это документировано у Microsoft (сущности *Resource Requirement* / *Resource Booking*):
- `From Date` / `To Date` — допустимый диапазон дат;
- `Date Window Start` / `Date Window End` — окно по датам;
- `Time Window Start` / `Time Window End` — окно по времени суток (дата не важна);
- `Time From Promised` / `Time To Promised` — **обещанное клиенту окно** (дата + время), приоритетнее остальных: «если поля времени и даты содержат противоречивую информацию, RSO использует Time From/To Promised в первую очередь».
([Microsoft Learn: Optimization goals in RSO](https://learn.microsoft.com/en-us/dynamics365/field-service/rso-optimization-goal))

🔵 У Salesforce аналог — обязательные поля `Earliest Start Permitted` и `Due Date` плюс `Scheduled Start`/`Scheduled End` для окна прибытия. ([Salesforce Help: Service Appointment Fields](https://help.salesforce.com/s/articleView?language=en_US&id=fs_appointment_fields.htm&type=0))

🟡 **Вывод для нас:** в MVP достаточно двух уровней — **hard-окно** (обещано клиенту, нарушать нельзя → заявка уходит в «нераспределённые») и **soft-предпочтение** (желательное время → штраф в целевой функции). Именно так устроено разделение hard/soft в промышленных API, и именно это даёт материал для объяснений («не влезает в обещанное окно» vs «влезает, но с опозданием на 12 минут от желаемого»).

### 1.5. Ключевые метрики домена

| Метрика (EN) | Русский вариант | Определение (🔵) | Бенчмарк (🔵) | Источник |
|---|---|---|---|---|
| **First-Time Fix Rate (FTFR)** | Доля заявок, закрытых с первого выезда | % сервисных запросов, решённых за первый визит | лучшие организации — 85%+ | [ServiceTitan](https://www.servicetitan.com/blog/field-service-metrics) |
| **Technician Utilization** | Загрузка (утилизация) инженера | продуктивное время / общее доступное время | целевой коридор 75–80% (выше — выгорание) | [NetSuite](https://www.netsuite.com/portal/resource/articles/erp/field-services-kpis-metrics.shtml), [FieldCamp](https://fieldcamp.ai/blog/field-service-metrics/) |
| **Travel Time Ratio** | Доля времени в пути | время в дороге / общее рабочее время | должно быть ниже 20–25%; ручная диспетчеризация обычно 35–40% | [FieldPie](https://www.fieldpie.com/blog/technician-travel-time-optimization/), [formsonfire](https://www.formsonfire.com/blog/field-service-metrics-and-kpis) |
| **SLA / On-time arrival** | Соблюдение окна визита | % визитов, начатых внутри обещанного окна | оптимизация даёт +25–50% к on-time performance | [FieldPie](https://www.fieldpie.com/blog/technician-travel-time-optimization/) |
| **Jeopardy** | «Риск срыва» визита | «ситуация jeopardy означает, что работа не уложится в обещанное окно обслуживания» | — | [Oracle](https://docs.oracle.com/en/cloud/saas/field-service/faaca/t-identifyJeopardySituations.html) |

🔵 **Jeopardy management** — отдельный управленческий контур, а не просто индикатор:
- Oracle Field Service: визиты в jeopardy показываются «розовыми блоками» в List View и Time View, цвет настраивается; текст статуса можно выводить в подсказке. Диспетчер может (1) перенести работу на ресурс со свободным временем, (2) вернуть её в bucket для перемаршрутизации позже, (3) не делать ничего, если ресурс всё же успевает. ([Oracle](https://docs.oracle.com/en/cloud/saas/field-service/faaca/t-identifyJeopardySituations.html))
- Salesforce: «визиты в jeopardy подсвечиваются красным, чтобы диспетчер быстро находил проблемные», правила jeopardy задаются через Data Scanners, состояние выставляется и снимается автоматически с уведомлением диспетчера. ([Salesforce Help: Jeopardy (SLA) Notification](https://help.salesforce.com/s/articleView?id=ind.comms_jeopardy__sla__notification.htm&language=en_US&type=5))

🟡 **Продуктовый вывод:** «jeopardy-лента» — дешёвая и очень «взрослая» фича для демо. Считается тривиально (ETA прибытия > конца окна) и сразу даёт диспетчеру ленту «что горит прямо сейчас».

### 1.6. Глоссарий RU ↔ EN (для продукта и питча)

| English | Русский (рекомендуемый) | Комментарий |
|---|---|---|
| Field Service Management (FSM) | Управление выездным обслуживанием | Устоявшийся перевод в РФ ([HubEx](https://hubex.ru/blog/tpost/r5d2psmku1-upravlenie-viezdnim-obsluzhivaniem-fsm-z)) |
| Work Order | Наряд / наряд-заказ | Основной документ работы (Salesforce: «Work Order») |
| Work Order Line Item | Строка наряда | Отдельная операция внутри наряда |
| Service Appointment | Визит / плановый визит | Единица планирования: «представляет запланированные интервалы времени, когда ресурс выполняет работу у клиента» |
| Service Resource | Исполнитель / выездной инженер / ресурс | В UI лучше «инженер», в модели данных — «ресурс» |
| Service Territory | Территория обслуживания / зона | Географическая область |
| Skill / Characteristic | Навык / компетенция | У Microsoft — «characteristics and proficiencies» (навык + уровень владения) |
| Skill Requirement | Требование к навыку | Что нужно уметь для наряда |
| Operating Hours / Working Hours | График работы / смена | |
| Time Slot | Временной слот | |
| Resource Absence | Отсутствие / недоступность ресурса | Отпуск, больничный |
| Assigned Resource | Назначенный исполнитель | |
| Scheduling Policy | Политика планирования | Набор правил + целей |
| Work Rule | Жёсткое правило / ограничение | *must* |
| Service Objective | Цель оптимизации | *prefer* |
| Dispatch / Dispatching | Диспетчеризация / отправка в работу | |
| Dispatcher Console / Schedule Board | Диспетчерская доска / панель диспетчера | |
| Gantt | Гант / таймлайн по исполнителям | |
| Unscheduled / Unassigned | Нераспределённые заявки | Отдельная панель в UI |
| Jeopardy | Риск срыва SLA | См. 1.5 |
| First-Time Fix Rate | Доля закрытия с первого выезда | |
| Utilization | Загрузка / утилизация | |
| Travel Ratio / Travel Time | Доля времени в пути / время в дороге | |
| Overtime | Сверхурочные / выход за смену | Salesforce: «Minimize Overtime Service Objective» |
| Rescheduling / Reshuffle | Перепланирование / перетасовка | Salesforce разделяет «Reschedule» и «Reshuffle» |
| In-Day Optimization | Внутридневная оптимизация | Salesforce: «Optimize Today's Schedule» |
| Bundling | Группировка визитов | Salesforce: «Appointment Bundling» |
| VRPTW | Задача маршрутизации транспорта с временными окнами | «scheduling visits to customers who are only available during specific time windows» ([OR-Tools](https://developers.google.com/optimization/routing/vrptw)) |
| Depot | Депо / склад / точка старта | |
| Pinning / Lock | Фиксация назначения | Microsoft: «booking lock options» |

---

## 2. Как это решают промышленные системы

### 2.1. Salesforce Field Service (Enhanced Scheduling & Optimization)

**Сущности** 🔵 ([Salesforce Help: Field Service Objects](https://help.salesforce.com/s/articleView?id=sf.fs_standard_objects.htm&language=en_US&type=5)):
`Work Order` → `Work Order Line Item` → `Service Appointment` (ядро планирования) → `Assigned Resource` → `Service Resource`; плюс `Service Territory`, `Skill`, `Skill Requirement`, `Operating Hours`, `Time Slot`, `Resource Absence`, `Maintenance Plan`, и конфигурация оптимизации: `Scheduling Policy`, `Work Rule`, `Service Objective`.

**Оптимизация** 🔵:
- **Scheduling Policy** = «rule-based framework», объединяющая work rules (фильтры) и service objectives (веса приоритетов). ([Salesforce Help: Create and Manage Scheduling Policies](https://help.salesforce.com/s/articleView?language=en_US&id=pfs_scheduling.htm&type=0))
- Принцип разделения сформулирован буквально: «если требование — *must*, это work rule; если *prefer* — это objective». ([Salesforce Help](https://help.salesforce.com/s/articleView?id=service.pfs_optimization_theory_work_rules_service_resource_availability.htm&language=en_US&type=5))
- **Типы work rules:** Match Fields, Match Skills, Match Territory, Match Time, Maximum Travel From Home, Required Resources, Service Appointment Visiting Hours, Service Crew Resources Availability, Service Resource Availability, TimeSlot Designated Work, Work Capacity, Working Territories.
- **Типы service objectives:** ASAP, Group Nearby Appointments, Minimize Gaps, Minimize Overtime, Minimize Travel, Preferred Resource.
- Как работает движок: «после того как Оптимизатор построил первое расписание, он оценивает его по Service Objectives вашей Scheduling Policy. Затем Оптимизатор строит тысячи — возможно, миллионы — других перестановок расписания и оценивает каждую», выбирая лучшую; он может перемещать, переназначать и снимать с расписания визиты. ([D5 Meta: FSL Scheduling Optimization](https://d5meta.com/fsl-scheduling-optimization/), [Trailhead](https://trailhead.salesforce.com/content/learn/modules/field-service-lightning-scheduling-basics/customize-a-scheduling-policy))
- **Сервисы оптимизации:** глобальная оптимизация, **In-Day Optimization** («Optimize Today's Schedule»), оптимизация расписания одного ресурса, **Appointment Bundling**, **Reshuffle / Reschedule**, **Sliding**, Multiday Work Optimization. ([Salesforce Help: Scheduling and Optimization Services](https://help.salesforce.com/s/articleView?id=service.pfs_scheduling_services.htm&language=en_US&type=5))

**Объяснимость** 🔵: главный механизм — вкладка **Candidates** в Dispatcher Console: work rules «действуют как фильтры, определяющие список подходящих кандидатов на визит, исключая тех, кто не соответствует критериям». Если список кандидатов пуст — значит все ресурсы не прошли одно или несколько правил политики. Плюс красная подсветка визитов в jeopardy. ([Trailhead: Manage Service Appointments](https://trailhead.salesforce.com/content/learn/modules/field-service-dispatcher-console-for-dispatchers/manage-service-appointments), [Salesforce Help](https://help.salesforce.com/s/articleView?id=service.pfs_dispatching_appointments.htm&language=en_US&type=5))

🟡 **Слабое место, которое мы можем закрыть:** система показывает *кто прошёл фильтры*, но не показывает в явном виде *почему остальные отпали* и *насколько хуже был бы альтернативный выбор*. Это ровно ниша нашей фичи объяснений.

### 2.2. Microsoft Dynamics 365 Field Service + Resource Scheduling Optimization (RSO)

Самая прозрачно задокументированная система — фактически готовая спецификация нашей модели ограничений.

🔵 **Ограничения (constraints)** ([Microsoft Learn: Optimization goals in RSO](https://learn.microsoft.com/en-us/dynamics365/field-service/rso-optimization-goal)):
1. **Schedule within working hours** — визит создаётся, если дорога до объекта и сама работа помещаются в рабочие часы ресурса; учитывается и дорога от последнего визита до конечной точки ресурса (при этом «доска расписания не показывает время в пути в конце дня»).
2. **Meets required characteristics** — ресурс обладает всеми требуемыми навыками и уровнями владения.
3. **Meets required roles** — у ресурса есть нужная роль (при нескольких ролях достаточно одной).
4. **Scheduling windows** — визит попадает во временное окно требования (см. 1.4, точные поля).
5. **Meets resource preferences** — три типа предпочтений: **Preferred** (желательно, но не гарантировано), **Restricted** (на этих не назначать), **Must choose from** (только из этого списка; если никто не доступен — заявка не планируется).
6. **Matches territories** — территория требования и ресурса совпадают; требование принадлежит одной территории, ресурс — нескольким.
7. **Matches resource type** — тип ресурса (Users, Contacts, Accounts, Equipment, Facility).

🔵 **Цели (objectives), ранжированные по порядку** — «можно выбрать несколько целей, но порядок имеет значение: чем выше в списке, тем больше предпочтения система отдаёт цели»:
1. **Maximize total working hours**
2. **Minimize total travel time** — важное замечание из документации: «эта цель не может быть первой в списке. Чтобы по-настоящему минимизировать время в пути, RSO может вообще не запланировать ни одного требования, требующего дороги».
3. **High priority requirements** — приоритет как option set с весами (`Level of Importance`: 10 у urgent, 1 у low); «одно срочное требование (важность 10 × 1 шт.) для RSO равноценно десяти низкоприоритетным (важность 1 × 10 шт.)». Нюанс: цель добивается планирования на *самый ранний день*, а не на *самый ранний слот внутри дня*.
4. **Maximize preferred resources**
5. **Best matching characteristic level** — «если все требуемые навыки совпали, система отдаёт приоритет ресурсам с *меньшим* числом навыков, чтобы сохранить более квалифицированных и уникальных специалистов для аварийных работ»; чем более переквалифицирован ресурс, тем ниже его score.
6. **Schedule as soon as possible**

🔵 **Параметры прогона:** `Engine Effort Level` («объём усилий, которые система вкладывает в поиск лучшей комбинации ресурсов, маршрута и дня/времени; более высокий уровень = больше рассмотренных комбинаций = дольше расчёт») и `Travel Time Calculation` (в т.ч. режим с учётом исторического трафика — до 500 требований в scope, рекомендуется запускать вне рабочих часов).

🔵 **Полуавтоматический режим — Schedule Assistant** ([Microsoft Learn: Schedule assistant overview](https://learn.microsoft.com/en-us/dynamics365/field-service/schedule-assistant)): «помогает диспетчерам назначить требования на идеальные ресурсы, рекомендуя ресурсы, подходящие по критериям вроде доступности, навыков и локации. Система также оценивает время в пути для рекомендованных ресурсов». Кандидаты **ранжируются** по доступности, навыкам, территории и оценке времени в пути. Фильтры: work location, characteristics, territory, resource types. Важное предупреждение в документации: «если вы бронируете вне рекомендованных ассистентом слотов, ограничения вроде вместимости, рабочих часов и временных окон **не проверяются и не применяются**».

🟡 Это прямое указание на UX-паттерн для нас: **ручной drag&drop должен не блокировать диспетчера, но честно помечать возникшие нарушения**.

### 2.3. Oracle Field Service (ex-TOA Technologies)

🔵 **Сущности/понятия:** activity (визит), resource, **bucket** (пул/очередь работ — в т.ч. «capacity bucket» для расчёта квот), capacity categories, time slots, routing plan, quota. ([Oracle: Add Capacity Categories and Time Slots](https://docs.oracle.com/en/cloud/saas/field-service/faadu/t-addCapacityCategoriesAndTimeslots.html))

🔵 **Оптимизация:** «Routing Cloud Service предоставляет опции ограничения времени в пути ресурса до работы». Дефолт — «минимизировать суммарное время в пути, даже если у отдельных работ дорога получится длиннее, что даёт наиболее оптимизированные маршруты»; альтернатива — «избегать поездок дольше N минут», что «приводит к меньшему числу назначенных работ и менее оптимальным маршрутам». ([Oracle: Control Travel Time Through the Routing Plan](https://docs.oracle.com/en/cloud/saas/field-service/farcu/t-controlling-travel-time-through-the-routing-plan.html))

🔵 **Объяснимость:** есть «Consolidated Unassigned Activity Report» — «пользователи могут видеть все работы, не назначенные во время прогонов Continuous Improvement routing, вместе с **причинами неназначения** в едином списке». Routing Run Summary показывает статус планов, число назначенных работ, средний пробег на маршрут, priority time spent/left. ([Oracle: Reading the Routing Run Summary](https://docs.oracle.com/en/cloud/saas/field-service/farcu/c-routing-runs.html))

🟡 Мысль для нас: «единый список нераспределённых с причинами» — это ровно тот экран, который мы должны показать жюри. Он есть у Oracle, но почти отсутствует у более лёгких решений.

### 2.4. IFS Field Service Management / IFS Planning & Scheduling Optimization (PSO)

🔵 В основе — **IFS Dynamic Scheduling Engine (DSE)**, который «непрерывно ищет улучшения»; «полностью динамический движок планирования, который всегда включён». Непрерывная оптимизация использует «35 различных алгоритмов и AI-отбор», автоматически справляясь с большей частью сложности и оставляя диспетчеру «высокоценные исключения». ([IFS PSO брошюра](https://www.ifs.com/assets/enterprise-service-management/ifs-planning-and-scheduling-optimization), [Gogh Solutions](https://goghsolutions.com/ifs-pso/))

🔵 **Automated Intelligent Travel Profile (AITP)** — профиль поездок на данных TomTom: «сплавляет данные о поездках в реальном времени с миллионов сенсоров, зондов и GPS-устройств, чтобы на лету рассчитывать время в пути». ([Gogh Solutions](https://goghsolutions.com/ifs-pso/))

🔵 «По-настоящему динамическое планирование позволяет PSO автоматически переприоритизировать и переназначать работы в случае болезни, отпуска или переработки», убирая необходимость ручного вмешательства.

🟡 **Что забираем:** идею «always-on оптимизации» в виде фонового пересчёта при событии (опоздание/авария), а не только по кнопке. Даже имитация этого в демо выглядит сильно.

### 2.5. ServiceMax (PTC) — Service Board

🔵 Service Board «автоматизирует планирование маршрутов, назначение визитов и оптимизацию ресурсов», используя «продвинутые алгоритмы и данные реального времени»; умеет многодневные работы, логистику запчастей и учёт гарантий. ([PTC: ServiceMax Service Board](https://www.ptc.com/en/products/servicemax/service-board))

🔵 У ServiceMax есть отдельный модуль **Jeopardy Management**: правила определяют условия, при которых Jobs и Appointments переводятся в состояние jeopardy; состояние выставляется/снимается автоматически, диспетчеры уведомляются. Типовые сценарии: «предпочитаемое время старта работы близко, а визиты ещё не запланированы» и «плановое время прошло, а инженер ещё не начал работу». ([PTC Support: About Jeopardy Management](https://support.ptc.com/help/servicemaxcore/en/articles/service_board/about-jeopardy-management.html) — страница отдаёт 403 роботам, содержание восстановлено по поисковой выдаче; помечаем как 🔵/частично непроверяемо)

### 2.6. Skedulo

🔵 API оптимизации `/optimization/schedule` принимает: `jobIds`, `resourceIds`/`resources`, `scheduleStart`, `scheduleEnd`, `timeZone` и объект `schedulingOptions` с параметрами ([Skedulo docs](https://docs.skedulo.com/developer-guides/manage-and-schedule-work/optimization-of-schedules/optimize-vs-suggest/optimized-scheduling-using-the-api/)):
- `balanceWorkload` — «выровнять суммарную назначенную длительность, включая время в пути»;
- `minimizeResources` — «попытаться назначить на минимальное число ресурсов»;
- `respectSchedule` — «не двигать» работы в статусе Pending Dispatch;
- `jobTimeAsTimeConstraint` — считать заданное время работы жёстким ограничением;
- `ignoreTravelTimes`;
- `maxTravelTimeInMinutes` — «не планировать узлы, время в пути до которых превышает это значение».

🔵 Ответ содержит план по каждому ресурсу (назначенные работы, времена старта, длительности, время в пути) **и массив `unscheduled`** для работ, которые не удалось запланировать.

🔵 Отдельно есть endpoints `Suggest: Resources and times for a job` и `Suggest: Times to schedule a job` — то есть архитектурно разделены «оптимизировать всё» и «подскажи варианты для одной заявки».

🟡 **Прямое заимствование в наш API:** два эндпоинта — `POST /plan/optimize` (весь день) и `GET /appointments/{id}/candidates` (ранжированные варианты для одной заявки). Второй — база для фичи объяснений.

### 2.7. Сводная таблица

| Система | Ключевые сущности | Как устроена оптимизация | Объяснимость | Что забрать в прототип |
|---|---|---|---|---|
| **Salesforce Field Service** | Work Order → Service Appointment → Assigned Resource; Service Resource, Territory, Skill, Operating Hours, Resource Absence; Scheduling Policy = Work Rules + Service Objectives | Перебор тысяч/миллионов перестановок с оценкой по взвешенным objectives; режимы: global, in-day, per-resource, bundling, reshuffle, sliding | Вкладка **Candidates** (кто прошёл фильтры); красная подсветка jeopardy; пустой список = не прошли work rules | Разделение **must-правил и prefer-целей**; веса целей в UI; список кандидатов по заявке; in-day оптимизация как отдельный режим |
| **MS Dynamics 365 FS + RSO** | Resource Requirement, Resource Booking, Bookable Resource, Characteristics+Proficiency, Territory, Resource Preferences | Ранжированный список objectives + жёсткие constraints; `Engine Effort Level`; учёт исторического трафика | Schedule Assistant: **ранжированные кандидаты** с оценкой времени в пути; явное предупреждение, что ручное бронирование вне слотов не проверяет ограничения | **Готовый чек-лист ограничений и целей**; модель `Preferred / Restricted / Must choose from`; идея «переквалифицированный = ниже score»; предупреждение при ручном drop |
| **Oracle Field Service** | Activity, Resource, **Bucket**, Capacity Category, Time Slot, Routing Plan, Quota | Routing plans с настройкой «минимизировать суммарную дорогу» vs «не дольше N минут на поездку» | **Consolidated Unassigned Activity Report с причинами неназначения**; Routing Run Summary с метриками прогона; jeopardy розовым в List/Time View | **Экран «нераспределённые + причина»**; **сводка прогона оптимизации** как артефакт; цветовая индикация риска |
| **IFS PSO** | Task, Resource, Shift, Skill; DSE | «Всегда включённый» динамический движок, 35 алгоритмов, AITP на данных TomTom | Публично слабо раскрыта; акцент на «диспетчер работает с исключениями» | Идея **автоматического перепланирования по событию** (болезнь/переработка); позиционирование «диспетчер = exception manager» |
| **ServiceMax Service Board** | Job, Appointment, Technician; Jeopardy Rules | Автоматизация маршрутов и назначений, многодневные работы, запчасти | **Jeopardy Management** как отдельный контур с правилами и уведомлениями | Правила jeopardy + лента уведомлений диспетчеру |
| **Skedulo** | Job, Resource, Allocation; `schedulingOptions` | REST API оптимизации с явными флагами (`balanceWorkload`, `minimizeResources`, `maxTravelTimeInMinutes`, `respectSchedule`) | Массив `unscheduled` в ответе; отдельные `Suggest`-эндпоинты | **Дизайн нашего API один-в-один**: optimize + suggest + unscheduled; флаги оптимизации как тумблеры в UI |

### 2.8. Что из UX промышленных систем стоит скопировать

🟡 (наша выжимка; детальные паттерны — в разделе 4)
1. Трёхзонный экран: список заявок — карта — гант по исполнителям.
2. Панель нераспределённых заявок как постоянный «инбокс» диспетчера.
3. Цветовая семантика статуса + отдельный цвет для риска срыва (jeopardy).
4. Список ранжированных кандидатов на заявку (Schedule Assistant / Candidates).
5. Разделение «жёстких правил» и «весов целей» в настройках, видимое пользователю.
6. Отдельный режим «оптимизировать сегодняшний день» вместо «пересчитать всё».
7. Честное предупреждение при ручном назначении, нарушающем ограничения.
8. Сводка прогона оптимизации (сколько назначено, сколько нет, средний пробег).

---

<!-- ANCHOR-SECTION-3 -->

---

## 5. Объяснимость решений оптимизатора (ключевая фича продукта)

### 5.1. Зачем это вообще нужно (аргументы для питча)

🔵 «Прозрачность рождает доверие, а доверие рождает использование. Компании, встраивающие объяснимость в AI-стек, видят более быстрое и широкое внедрение — и больший эффект.» ([BCG: AI and the Next Frontier of Field Service](https://www.bcg.com/publications/2025/the-next-frontier-of-field-service))

🔵 «Если AI позволено принимать решения без прозрачности, команды могут не понимать, почему работа была назначена, почему слот клиента был заблокирован или почему один инженер получил больше срочной работы, чем другой.» ([FieldCamp: AI Dispatching Manifesto](https://fieldcamp.ai/playbook/ai-dispatching/the-ai-dispatching-manifesto/))

🔵 «AI-диспетчеризация должна быть достаточно прозрачной, чтобы операционные команды понимали, почему была выдана та или иная рекомендация»; необходимы XAI, аудит-трейл и возможность человека «переопределить, приостановить или скорректировать решения». ([Fieldcode](https://fieldcode.com/en/field-service-daily/ai-dispatching-in-field-service-explained))

🔵 Академическая формулировка проблемы: «конечные пользователи, решающие задачи комбинаторной оптимизации вроде WSRP, часто не обладают подготовкой для понимания решений; разработка техник объяснения помогает улучшить их понимание и сохранить доверие к системе». ([Lerouge et al., ICORES 2023](https://www.scitepress.org/Papers/2023/116399/116399.pdf))

### 5.2. Три типа объяснений (таксономия, которую мы берём за основу)

| Тип | Вопрос пользователя | Механика | Пример формулировки |
|---|---|---|---|
| **Constraint-based** («почему нельзя») | «Почему Иванову нельзя отдать эту заявку?» | Проверка жёстких правил по кандидату, первый нарушенный constraint | 🔵 DecisionBrain (infeasible): «Anna cannot reach task C before 11:50 AM when its time-window closes» → «Иванов не успевает к заявке №С до 11:50, когда закрывается окно» |
| **Contribution / factor-based** («из чего сложилось») | «Почему именно этот исполнитель?» | Разложение оценки на вклад по факторам (дорога, навык, приоритет, окно) | 🔵 Timefold `ScoreAnalysis`: общий score → вклад каждого ограничения → конкретные `ConstraintMatch` с `justification` |
| **Contrastive / counterfactual** («а если бы») | «Почему не Анна?» / «Что изменить, чтобы это делала Анна?» | Перерешать задачу с принудительным альтернативным назначением, сравнить целевую функцию | 🔵 DecisionBrain: «Why is Anna not handling this task?» / «How to make Anna perform this task?» 🔵 RouteExplainer: «почему на шаге t выбрано ребро B-C, а не B-D» |

### 5.3. Как это делают конкретно

**DecisionBrain** 🔵 ([источник](https://decisionbrain.com/combinatorial-optimization/)) — самый практичный образец:
- Шаблоны вопросов: «Why is [employee], performing [task] and [task] consecutively, not performing [task] in between?», «Why does [employee] not perform [task] despite changing task order?». Контрфактические варианты — те же шаблоны с заменой «why» → «how to».
- Алгоритм контрастного объяснения: (1) трансформировать текущее решение, вставив спорную задачу; (2) оценить допустимость и качество; (3) сформировать объяснение по одному из трёх исходов: **недопустимо** (назвать нарушенное ограничение), **допустимо, но хуже** (показать проигрыш в эффективности), **лучше** (признать, что решение можно улучшить).
- Контрфактические объяснения считаются через MILP, ищущий минимальные изменения входных данных; «большинство объяснений считаются меньше чем за 15 секунд», что делает их пригодными для интерактива.

**RouteExplainer** 🔵 ([arXiv:2403.03585](https://ar5iv.labs.arxiv.org/html/2403.03585)) — академический фреймворк для VRP:
- Why/why-not вопрос формализуется как кортеж {фактический маршрут, объясняемый шаг, фактическое ребро, контрфактическое ребро}.
- Контрфактический маршрут строится так: «решаем экземпляр VRP, фиксируя рёбра до объясняемого шага и подставляя контрфактическое ребро» — то есть получаем оптимальный маршрут, содержащий и префикс фактического маршрута, и альтернативное ребро.
- Затем разница между фактическим и контрфактическим маршрутом переводится в текст.

**Lerouge et al. (WSRP)** 🔵 — «их подход позволяет конечным пользователям задавать 15 различных вопросов и получать в ответ контрфактические объяснения»; метод построен на математическом программировании и ищет **минимальные изменения данных**, удовлетворяющие запрос пользователя. ([ICORES 2023](https://www.scitepress.org/Papers/2023/116399/116399.pdf), [ITOR 2024](https://onlinelibrary.wiley.com/doi/10.1111/itor.13594), [препринт автора](https://mathieulerouge.github.io/Modeling_and_generating_user_centered_contrastive_explanation_for_the_WSRP.pdf))

**Timefold / OptaPlanner** 🔵 ([Timefold blog](https://timefold.ai/blog/timefold-solver-1-4-brings-explainable-score), [Timefold docs](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score), [OptaPlanner Javadoc: Indictment](https://docs.optaplanner.org/7.8.0.Final/optaplanner-javadoc/org/optaplanner/core/api/score/constraint/Indictment.html)) — инженерный образец формата данных:
- `ScoreAnalysis` — «разбивка score по ограничениям», показывает, «какие ограничения влияют на решение сильнее всего».
- `ConstraintAnalysis` содержит список `matches` — «индивидуальных нарушений ограничения».
- `justification` — структурированные данные о том, «какие planning entities или значения вызывают нарушение ограничения»; пример из школьного расписания: `"lessonId1": 5, "lessonId2": 17, "teacher": "I. Jones"`.
- `Indictment` — «набор constraint matches и сумма их score» по конкретной сущности, то есть «кто виноват» в том, что решение хуже.
- Всё это автоматически сериализуется в JSON — фронт может показать иерархию «общий score → вклад ограничения → конкретное нарушение».

**Google OR-Tools** 🔵 ([Penalties and Dropping Visits](https://developers.google.com/optimization/routing/penalties)) — механика «почему заявка не назначена» на уровне модели: через `AddDisjunction` каждой точке присваивается штраф за пропуск; «бóльшие штрафы приоритизируют выполнение как можно большего числа доставок, меньшие — позволяют отбрасывать точки, когда это выгодно». Печать решения расширяется списком dropped locations.

🟡 Это значит: **«нераспределённая заявка» — это не сбой, а нормальный выход модели**, и величина штрафа/причина отбрасывания сами по себе являются объяснением.

### 5.4. Библиотека формулировок для нашего UI (🟡 наша разработка на основе 5.2–5.3)

**A. Почему эта заявка этому исполнителю** (contribution-based, показываем 3–4 фактора):
> «Заявка №1423 → **Петров И.** Ближайший подходящий инженер: 4,2 км от предыдущего визита (следующий по близости — Сидоров, 11,8 км). Есть требуемый навык *Монтаж ВОЛС* (уровень 3 из 3). Приезд в 13:40 — внутри окна 13:00–16:00, запас 2 ч 20 мин. Вклад в общий план: −7,6 км пробега против среднего альтернативного варианта.»

**B. Почему не тот, кого ожидал диспетчер** (contrastive, counterfactual):
> «Если назначить **Сидорова А.**, план останется допустимым, но станет хуже: +11,4 км пробега, приезд в 15:50 (запас до конца окна — 10 мин), одна заявка №1502 уйдёт в нераспределённые. Итоговая оценка плана: 842 → 977 (хуже на 16%).»

**C. Почему исполнитель не подошёл вообще** (constraint-based, по первому нарушенному правилу):
> «**Кузнецов В.** — не подходит: нет навыка *Пусконаладка АТС*.»
> «**Смирнов П.** — не подходит: не успевает, ближайшее прибытие 16:40, окно закрывается в 16:00.»
> «**Волков Д.** — не подходит: смена заканчивается в 18:00, работа завершилась бы в 18:35.»
> «**Орлова Е.** — не подходит: другая территория обслуживания (Юго-Запад вместо Центр).»

**D. Почему заявка вообще не назначена** (unassigned reason):
> «Заявка №1587 не назначена. Ни один из 12 инженеров не подходит: у 9 нет навыка *Монтаж ВОЛС*, 2 не успевают в окно 09:00–11:00, у 1 нет свободного времени в смене. Ближайшая возможность: Петров И., завтра 09:30.»

**E. Что изменилось после перепланирования** (diff):
> «Пересчёт занял 1,8 с. Перемещено 6 визитов из 47. Общий пробег 412 → 389 км (−5,6%). Нераспределённых 3 → 1. Нарушений SLA 2 → 0. Затронуты: Петров (+2 визита), Сидоров (−1 визит), Кузнецов (порядок визитов изменён).»

🟡 **Инженерная реализация за хакатон (минимальная):**
1. При решении сохранять по каждому назначению словарь вкладов: `travel_delta`, `window_slack`, `skill_match`, `priority`, `overtime`.
2. Для «почему не X» — не полное перерешивание, а **локальный пересчёт**: принудительно вставить заявку в маршрут X в лучшую позицию, пересчитать маршрут X и маршрут исходного исполнителя, сравнить целевую функцию. Это O(длина маршрута), считается мгновенно.
3. Для «не подошёл» — прогонять кандидата по упорядоченному списку жёстких правил и возвращать **первое** нарушенное с человекочитаемым текстом (порядок правил = порядок понятности для диспетчера: навык → территория → окно → смена → занятость).
4. Формулировки — шаблоны с подстановкой чисел; LLM для генерации текста не нужен (и рискован на демо).

---

<!-- ANCHOR-SECTION-6 -->
