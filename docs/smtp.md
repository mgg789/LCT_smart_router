# Внешний SMTP — mail.droidje.com

Почтовый контур живёт на отдельном хосте и не входит в Docker-сеть приложения
(`context/32` §13, `context/35` §10). Sys формирует письмо; SMTP-gateway передаёт
его; Postfix держит очередь. Статуса `delivered` в приложении нет.

## Хосты

| Роль | Адрес | Что слушает |
|---|---|---|
| SMTP | `194.87.202.172`, `mail.droidje.com` | Postfix 25 (локальная доставка/bounce), 587 (submission), Hysteria UDP/443, watchdog `127.0.0.1:8587` |
| MGG | `178.140.207.217` | Hysteria-клиент: `0.0.0.0:2525` / `:8587` (с хоста всё ещё `127.0.0.1`); API в compose ходит на `host.docker.internal` |

Отправитель: `Navix <noreply@mail.droidje.com>`. EHLO: `mail.droidje.com`.
Установлено: Postfix 3.6.4 (Ubuntu 22.04), OpenDKIM, certbot, Hysteria 2.6.2
(существующий сервер не обновляли).

## Сеть

Нормальный режим — `VPN_ONLY`: публичный TCP/587 закрыт iptables-цепочкой
`NAVIX_SMTP`. Контейнер API ходит в `host.docker.internal:2525` (хостовый
Hysteria). С самого хоста по-прежнему `127.0.0.1:2525`. UFW на MGG —
`INPUT DROP`; `deploy-remote.sh` держит контейнер `navix-smtp-host-allow`,
который открывает только docker-bridge на 2525/8587, не публичный NIC.

Hysteria 2 на SMTP-хосте — односторонний прокси, поэтому heartbeat едет
MGG → SMTP (`POST /beat` каждые 15 с). Три пропущенных интервала
(`WATCHDOG_BEAT_STALE_SEC=45`, порог 3) открывают публичный 587 с тем же
SASL+TLS (`VPN_PLUS_DIRECT_TLS`). Три успешных бита возвращают `VPN_ONLY`.

Неавторизованный клиент отвергается и в VPN, и в fallback. Это не open relay.

## Очередь

Администрирование — стандартный Postfix, без web-UI.

```bash
mailq
postqueue -p
postsuper -d ALL          # только осознанно
curl -sS http://127.0.0.1:8587/health
```

Health отдаёт `postfix`, `accepts_mail`, `queue_depth`, `access_mode`,
`last_errors`. Это не доказательство доставки в ящик.

## DNS, которые ещё должен выставить владелец зоны

A и PTR уже сходятся: `mail.droidje.com` ↔ `194.87.202.172`. MX `droidje.com`
указывает на `mail.droidje.com`. Сейчас SPF — Timeweb `include:_spf.timeweb.ru`,
поэтому Gmail отвечает `550 5.7.26` (SPF/DKIM не проходят). В панели Timeweb
нужны записи:

```
mail.droidje.com.                TXT  "v=spf1 ip4:194.87.202.172 -all"
navix._domainkey.mail.droidje.com. TXT  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu2fyYIenrsiVWrax6SZRpOd81jUX2lzYu0eViIHPE6Kc2E7LXck5QnE45qcSIzoTLuII/9n2jg+dAhx/hVM4sDmWgtkxY7P77uA6kkfIgZziPJrvmqD2Q5uPzDS4Tt6BwTD9pXZUgriPw+WHyZvt7Y0LjZtaiHdKcwmiOEowvyDc/ZYVibMBSX0YD0qbf7YFFh2gqmI8Sbo/IcfV2mzCN+Hnd4jJa5PTeKOKDKed+QZCVUk3t+43/LlW/hhMQc94qh9y/E//1XCjEkLIPhqS457ftzQE16I4+3ViDND2ek34aIvw3++9M1ZixbSCiS7taWqFX3jqF5HgFmtYxo0D1wIDAQAB"
_dmarc.mail.droidje.com.        TXT  "v=DMARC1; p=quarantine; adkim=s; aspf=s;"
```

Публичный ключ также лежит на хосте в `/etc/navix-smtp/dkim-navix.txt`.
После публикации TXT повторить отправку на Gmail/Yandex/Mail.ru.

## Sys: SMTP-gateway

Модуль `apps/api/src/notifications`. Без `SMTP_HOST` health остаётся
`not_configured`, парольный вход диспетчера жив. На MGG в `/home/mgg/navix/.env`
уже прописаны `host.docker.internal`, fallback и health URL.

Каталог писем: `account_login_code`, `request_received`, `engineer_assigned`,
`visit_change_required`. UI ввода кода — карточка DRO-39.

## Деплой SMTP-хоста

Конфиги — [`infra/smtp/`](../infra/smtp/). CD после push в `main` заливает дерево
пользователю `deploy` и вызывает `sudo /usr/local/sbin/navix-smtp-apply`.
Полный clone монорепы на почтовом хосте не нужен.

Первичная раскладка ключей: [`scripts/ci/bootstrap-smtp-host.sh`](../scripts/ci/bootstrap-smtp-host.sh).
Ручной ключ ноутбука лежит в `authorized_keys` у `root`/`deploy`/`mike`;
в SourceCraft идёт отдельный deploy-only ключ, не пароль и не личный ключ.

## Проверки, которые уже сделаны

- A/PTR совпадают; Let's Encrypt для `mail.droidje.com` выпущен.
- Relay без SASL с порта 25 отвергнут.
- Публичный 587 в `VPN_ONLY` не принимается (timeout снаружи).
- Submission через Hysteria с MGG (`127.0.0.1:2525`) принят сервером.
- Watchdog переключает `VPN_PLUS_DIRECT_TLS` ↔ `VPN_ONLY` по битам.
- Конечная доставка в Gmail **не** подтверждена, пока нет SPF/DKIM в DNS.
