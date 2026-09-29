# Выдача вложения Navix

`services/distribution` — отдельный stdlib Python-сервис на loopback `127.0.0.1:18891`.
`GET /navix/status` публично возвращает `{open:boolean}`. `POST /navix/data` принимает
`{"pin":"123456"}` и при открытой выдаче отдаёт файл как attachment. PIN хранится только как
`NAVIX_PIN_SHA256`; обязательны `NAVIX_IP_HMAC_KEY`, `NAVIX_PAYLOAD_PATH`, `NAVIX_STATS_DB`.
SQLite хранит лишь время, HMAC IP и outcome; тело, PIN и секреты не логируются. Ошибки PIN
ограничены `NAVIX_FAILURE_LIMIT` в `NAVIX_FAILURE_WINDOW_SEC`. Ответы `no-store`.

Шаблон запуска: `docker compose -f services/distribution/docker-compose.yml up -d --build`.
Скопируйте `services/distribution/distribution.env.example` в `distribution.env` и заполните
значения только на хосте; файл не попадает в репозиторий. Compose монтирует локальные
`./state` и `./payload`. `NAVIX_BIND=0.0.0.0` установлен только внутри контейнера, а хостовой
порт остаётся loopback. `NAVIX_TRUST_PROXY=true` разрешён только за доверенным nginx: тогда
проверяется `X-Real-IP`, иначе ключ лимита — адрес TCP-пира. Статистика: `python
server.py --stats` внутри контейнера. Для внешнего доступа launcher должен проксировать только
указанные пути на loopback; сервис сам TLS и публичный bind не создаёт.

Статус также содержит `mode: "open" | "closed"` и `pin_required: true`. Лимит применяется
ко всем попыткам выдачи, включая успешные, до чтения тела запроса. Максимальный размер
вложения — 256 КиБ. Статистика доступна только оператору: `docker compose exec
 distribution python /app/server.py --stats`.

Перед первым запуском создайте `state` и `payload`, назначьте им владельца UID 65534
(контейнер работает без root). Каталоги — 0700, файл `payload/navix.env` — 0600.
`distribution.env` должен оставаться 0600 и принадлежать оператору запуска Compose.
В нём задайте `NAVIX_PAYLOAD_PATH=/payload/navix.env`. PIN передавайте получателю отдельно;
его не следует добавлять в URL, логи, shell history или репозиторий.

Для закрытия выдачи установите `NAVIX_DISTRIBUTION_OPEN=false` в приватном env и
пересоздайте только контейнер дистрибуции. Для ротации замените PIN hash и пакет данных.
TLS завершается на nginx; прокси должен перезаписывать X-Real-IP и запрещать кэширование.
Выдаваемый пакет должен содержать ключи, предназначенные для установок пользователей,
а не пароли БД или сессии уже действующего сервиса.

## Публичная проверка версии

`GET /navix/version` доступен без PIN и независимо от `NAVIX_DISTRIBUTION_OPEN`.
Ответ содержит `schema_version: 1`, `version` и `download_url`, без приватных настроек.
Оператор задаёт `NAVIX_LATEST_VERSION` и `NAVIX_DOWNLOAD_URL` для реально
опубликованного и проверенного пакета. Ссылка должна быть HTTPS и не содержать
credentials. Значения не выводятся из PIN или содержимого выдаваемого `.env`.
Если оба поля не настроены, endpoint возвращает 503 `release_not_configured`;
status/data продолжают работать. Неполная или недопустимая конфигурация не публикуется:
проверка версии получает 503, а существующая выдача настроек продолжает работать.

В nginx нужен отдельный маршрут `/navix/version` на тот же loopback-сервис.
Перед публикацией обновления подготовьте package version/manifest, проверьте
ссылку на пакет и только затем обновите метаданные сервиса. Для отката сохраните
прежний образ и приватную конфигурацию; перезапускается только distribution.

Лаунчер ограничивает размер ответа и время ожидания, проверяет формат и показывает
устаревшую версию как рекомендацию скачать обновление. Сохранённый ответ используется
при недоступном сервисе только с датой прежней проверки. Невалидный ответ не заменяет
кэш; ошибка TLS не обходится.

## Проверенное развёртывание — 28.09.2026

Сервис обновлён отдельно в `/home/mgg/navix-distribution`, Compose-проект
`navix-distribution`. Публичный `https://distribute.droidje.com/navix/version`
возвращает HTTP 200, `schema_version=1`, `version=1.7.0` и постоянную страницу
[релиза v1.7](https://sourcecraft.dev/lct-hackaton-2026/case-13-field-engineer-routing-team-22/releases/v1.7).
Официальный API SourceCraft подтвердил `published`, `is_latest=true`, отсутствие
prerelease и commit `b885a08861e8d0c1fa7e22ef73b6f4907c7a07ef`.

Репозиторий приватный: скачивание на странице релиза требует доступа SourceCraft.
API отдаёт архивы с временным `token` в ссылке; такие ссылки не сохраняются в
публичных метаданных. Постоянная страница соответствует маршруту SourceCraft
`/:owner/:repo/releases/:tag`. Права репозитория и публикация архивов не менялись.

Существующий nginx уже проксирует `/navix/` на `127.0.0.1:18891`, поэтому его
конфигурация и сертификат не изменялись. Сертификат `distribute.droidje.com`
действителен с 27.09.2026 до 26.12.2026. Запросы HTTPS проверены на сервере,
через Windows curl и через исправленный Python-клиент лаунчера.

До обновления сохранены прежний образ, код, приватная конфигурация, выдаваемый
файл и согласованная копия SQLite в закрытом каталоге
`/home/mgg/navix-distribution-backups/20260928-1700` (0700). Образ для отката:
`navix-distribution-rollback:20260928-1700`. Код прошёл пять тестов в отдельном
контейнере без внешней сети. Пересоздан только сервис `distribution` через
`compose up --no-deps --build --wait`.

После обновления: health healthy, прежняя выдача остаётся open/PIN-required,
payload и все настройки кроме двух полей версии сохранены, SQLite integrity=ok,
2435 прежних событий присутствуют. Идентификаторы и образы остальных работающих
контейнеров не изменились. Санитизированное свидетельство:
[distribution-validation-20260928.json](benchmarks/distribution-validation-20260928.json).

Для отката кода восстановите `server.py` и `distribution.env` из указанной копии,
перетегируйте rollback-образ в `navix-distribution-distribution:latest` и выполните
`docker compose -p navix-distribution -f /home/mgg/navix-distribution/docker-compose.yml up -d --no-deps --no-build --wait distribution`.
Текущие БД и payload при таком откате сохраняются.

Проверки Windows-клиента с настоящим endpoint: для тестовой версии 1.6.0 возвращается
`update_available`, для 1.7.0 — `current`, для сборки разработки — `development`;
при offline сведения помечаются `source=cache`. Свежий релиз публикуется отдельным
процессом команды; при его публикации оператор обновляет два поля метаданных.
