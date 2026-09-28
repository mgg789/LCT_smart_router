# Real-UI interaction map used by the capture scripts

Every locator below was read out of `apps/web/src` and the Russian strings resolved
through `apps/web/src/i18n/ru.ts`. The reel films the running stand — no mock screens,
no redrawn panels. Keep this file in sync with the app when copy changes.

## Stand

| Piece | Address |
|:---|:---|
| Web (nginx, built bundle) | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:8000/api/v1` |
| Dispatcher surface | `/` |
| Engineer surface | `/engineer` |
| Client surface | `/client` |

`AUTH_DEV_EXPOSE_CODES=true` on this stand, so `POST /api/v1/auth/login-code` answers with
`devCode` and the login screens print the code themselves. That is what the reel films when
the engineer waits for the code — a real code, really delivered.

## Viewports

- Dispatcher artboard is `1920x1080` and scales with CSS `zoom`
  (`figma-dashboard/artboardScale.ts`), so a `1920x1080` viewport is 1:1.
- Engineer and client share a `670x1455` artboard capped to a `430` px column
  (`figma-engineer/engineerScale.ts`, `index.css .engineer-phone`). A `430x932` viewport
  fills the column edge to edge.
- The two-pane desk shell needs `width >= 1180 && height >= 620`
  (`figma-engineer/phoneDesk.ts`), so a phone viewport never triggers it.

## Dispatcher

| Step | Locator |
|:---|:---|
| Email | `#dispatcher-email` |
| Ask for code | button `Получить код` |
| Password fallback | link `Войти паролем`, then `Пароль`, then `Войти` |
| Code digits | `aria-label` `Цифра 1 из 6` … `Цифра 6 из 6` (6th digit auto-submits) |
| Dev code on screen | text `Код для локальной отладки: ` |
| Start the shift | button `Начать рабочий день` (`WelcomeScreen.tsx`) |
| Sidebar | `aria-label` `План дня`, `Заявки`, `Инженеры`, `Алерты`, `Политики`, `AI` (`Чаты` is disabled) |
| Nav state | plain component state in `MainDashboardPage`, never in the URL — no page can be deep-linked, each one is reached by pressing its rail button |
| Header | `Метрики плана`, `Добавить`, `Меню пользователя`, bell `Показать уведомления`, policy pill `Политика: …` |
| Policy pill open | header `Выбери свою политику` |
| Metrics modal | `h2#plan-metrics-title` = `Метрики плана`; `Оптимизировать`; `Сравнить политики` in its header; result heading `Оценка AI` |
| Metrics AI toggle | `aria-label` `Объяснить с AI`, top right of the grade panel — **rendered only for a yellow or a red band** (`qualityBand`, `domain/planQuality.ts`). A plan the model calls green has no such button, which is why `ensureGradedPlan()` asks the header for a different strategy before filming the dialog |
| Policy comparison | page `Сравнение политик`; view tabs inside `fieldset[aria-label="Вид сравнения"]`: `Обзор` / `Таблица` / `Карта`. It starts empty — `Сравнить` / `Пересчитать` fills it (`GET /dispatch/policy-comparison`, up to 90 s) and `Карта` runs its own `POST /dispatch/simulate` |
| Comparison colours | `STRATEGY_COLORS` (`PolicyStrategyMap.tsx`): fast `#E11D48`, compact `#2563EB`, sla `#16A34A`, balanced `#D97706`, eco `#0F766E`, covering `#7C3AED`, baseline `#272930` |
| Replan diff | card `aria-label` `Изменения после перепланирования`, title `Что изменилось` |
| Toast action that opens it | `[data-toast-action]` `Подробнее` |
| Alerts page | `section[aria-label="Алерты и уведомления"]`; `Решить с AI` → `.ai-reason-shimmer` → `.ai-choice-ring` on the chosen option → 2000 ms hold → card flies out over 480 ms |
| Alert actions, disabled | every action is disabled while writes are off, and writes are off while the snapshot source is not live, while a snapshot is loading, while another mutation is pending, or while a warning is unanswered (`useDashboard.ts`). A freshly loaded board is loading for a few seconds, so **wait for the button to be pressable, not merely present** |
| Action tooltip | hovering an action for 700 ms portals a `role="tooltip"` panel under it — what the reel shows before the press |
| Notifications panel | bell `Показать уведомления` / `Скрыть уведомления`, `[data-notif-panel]`, opens `ToastColumn` at `z-[80]` **over the whole dashboard**, with an invisible collapse-catcher across the middle of the artboard. It swallows clicks meant for anything underneath — the assistant's composer included. Do not open it in a scene that then presses something |
| AI pane | textarea `Сообщение ассистенту`, placeholder `Спроси меня о чем нибудь...`, send `Отправить`. Sending needs a live token **and** a bootstrapped conversation, so the send button is disabled for a moment after the page opens; `.ai-think-dot` marks the assistant writing before the first token arrives |
| End of day | `Меню пользователя` → `Завершить день` (`DispatcherDayResults`, title `День под контролем`), closed again with `aria-label` `Закрыть итоги` |
| Day result figures | `GET /dispatch/performance/day`: «выполнено» counts requests really completed inside the workday, «работа с отметками» sums matched `started`/`finished` engineer facts, «алерты» scores resolved blocking alerts. Nothing seeds these — the engineer has to actually work the day, which is what `workTheDay()` does between takes |
| Plain board | with nothing selected the board is the engineer column plus the wide map; selecting an engineer adds the bottom pipeline and the right panel and narrows the map. Deselect with `aria-label` `Закрыть панель` |

Artboard rects (artboard units, before window stretch): sidebar `0,0 158xH`; engineer column
`180,138 411x909`; map `623,138` (`1267x909` expanded / `751x909` / `751x598`); route card
`623,768 751x279`; right detail panel `1406,138 484x909`; header row at `top:10` with
`Метрики плана` at `left:1081 w:232`, `Добавить` at `left:1014`, policy pill at `left:1329`,
bell panel at `left:1407 w:363`, avatar at `left:1800`.

### Map: points → dashed → roads

`components/DayMap.tsx` draws every planned edge either as real router geometry or, while the
geometry for that edge has not arrived, as a straight chord chopped into dashes by
`pillDashLine()` (`domain/mapPaint.ts`). The snapshot carries `geometryDone` / `geometryTotal`;
while `done < total` the dashboard shows the progress toast `Уточняем линии на карте` and each
poll swaps more dashed chords for real polylines. Sources/layers: `routes` →
`routes-casing` / `routes-line`, `starts`, `stops` → `stops-circle` / `stops-label`, `lunches`,
`unassigned`, `handoffs`, `live-progress-lines`. `[data-map-ready]` marks a painted map.

Colours the storyboard asks for by name: a leg whose `travelSource` is `metro` is drawn
purple `#8B5CF6`, a leg carrying a `handoffId` is drawn blue `#2563EB` with the meeting
point on the `handoff-point` layer, lunch is `#E2B6A5` filled and `#EC6A26` stroked, an
emergency is `#E23B3B`. None of those exist on a stand where the matching router flags are
off: `metroEnabled`, `lunchesEnabled`, `equipmentEnabled` and `equipmentTransfersEnabled`
live behind `PUT /dispatch/router/technical-settings`, and `capture/prepare.ts` turns them
on and appends the work that gives the router a reason to use them.

## Engineer (`/engineer`, test@mail.ru)

| Step | Locator |
|:---|:---|
| Email | `#eng-login-email` |
| Submit | button `Войти` |
| Code digits | `aria-label` `Цифра N из 6`. The cells carry no border of their own — the dark ring the camera picks up is Chrome's focus outline, taken off at capture time by `hideCodeCellFocus()` |
| Code on screen | text `Демо код {code} без срока` |
| Go on shift | overlay heading `Выйти на смену`, button `Выйти на линию` |
| Start the job | button `Приступить` |
| Finish the job | button `Завершить` |
| Running late | button `Опаздываю` |
| Day scroller | the single `div.overflow-y-auto` under `.engineer-phone` |
| Lunch row | text `Обед` + window. Present only when the plan carries a lunch stop, which needs `lunchesEnabled` on in the router's technical settings |
| Menu | `aria-label` `Меню` → `Мой день` / `Помощник` / `Настройки` |
| Day result | button `Мой результат дня`, dialog `Смена в копилке` |

## Client (`/client`)

| Step | Locator |
|:---|:---|
| Free-text tab | `role=tab` `Авто` (the form tab `Форма` is the default) |
| Free-text field | placeholder `Расскажите, что у вас случилось, когда к вам приехать, ваше ФИО и email` |
| Send the story | `aria-label` `Отправить рассказ` → 1400 ms perimeter trace → form, then the real `POST /api/v1/client/interpret` fills it |
| Work type | `aria-label` `Тип заявки` (native select); emergency option label `Авария` (`outage`) hides the window fields |
| Name / address | `#client-name` (`Иван Иванов`) / `#client-address` |
| Window | `#client-window-start` / `#client-window-end` |
| Email | `#client-email` |
| Map | `aria-label` `Карта адреса заявки`; the first geocoder hit auto-sets the point, so a resolvable address is enough |
| Send | button `Отправить` |
| Email gate | `#client-gate-email`, `Получить код` / `Подтвердить`, digits `Цифра N из 6` |
| Sent screen | heading `Заявка отправлена`, buttons `Мои заявки` / `Ещё заявка` |

Neither surface has a single `data-testid`; text, `aria-label` and the handful of ids above are
the stable anchors.
