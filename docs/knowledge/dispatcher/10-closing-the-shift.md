---
id: disp-10-closing-the-shift
segment: dispatcher
title: Закрытие смены
summary: Смену нельзя закрыть, пока остаётся хотя бы один нерешённый блокирующий алерт, и сервер проверяет это заново на своей стороне в момент закрытия, а не доверяет счётчику, который диспетчер видел раньше.
tags: [shift, close, alerts]
actions: [get_shift_status, list_alerts, prepare_close_shift]
related: [disp-04-alert-time-risk-unassigned, disp-01-day-shape]
updated: 2026-09-20
---

## Условие закрытия

`GET /dispatch/shift?workDate=YYYY-MM-DD` возвращает `{workDate, closedAt, unresolvedCount}`.
`unresolvedCount` — число алертов с `kind='alert'`, `isBlocking=true`,
`resolvedAt=null`, `invalidatedAt=null` — независимо от конкретной даты алерта
(закрытие любой смены — финализация уровня диспетчера в целом, её нельзя обойти
фильтром по дате). Пока это число больше нуля, `POST /dispatch/shift/close` вернёт
`SHIFT_CLOSE_BLOCKED`.

## Что блокирует, что нет

Блокируют только алерты (`kind='alert'`) с `isBlocking=true` — то есть коды с непустым
списком действий (`time_risk`, `unassigned`, `plan_degraded`, `plan_review_required`,
`lunch_conflict`, `engineer_overdue`, `shift_no_show`). Уведомления (`kind='notice'`,
например `plan_rebuilt`) никогда не блокируют закрытие — у них нет действий и они
информационные по определению. «Просмотрено» (`seen`) тоже не решает алерт и не снимает
блокировку — это разные признаки: факт прочтения не меняет реального состояния.

## Порядок действий

1. Прочитать `GET /dispatch/alerts` и решить каждый открытый блокирующий алерт через
   `POST /dispatch/alerts/:id/resolve` соответствующим действием.
2. Перепроверить `GET /dispatch/shift` — `unresolvedCount` должен стать нулём.
3. Вызвать `POST /dispatch/shift/close` с `operationId` и `workDate`.

Сервер сам перечитывает состояние алертов заново при вызове `close` — гонка (новый
алерт появился между чтением и закрытием) обрабатывается на сервере, а не на
доверии к тому, что видел диспетчер минуту назад.

## После закрытия

Закрытие смены (`shiftClosure`) — отдельный факт от завершения LIVE-дня
(`workday.status='finished'`, по исчерпанию расписания или концу логических часов).
Не путать одно с другим: день может завершиться сам по расписанию, но смену всё равно
нужно закрыть явным действием диспетчера после разбора всех алертов.
