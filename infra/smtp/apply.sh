#!/usr/bin/env bash
# Idempotent apply of the Navix SMTP host from a copied infra/smtp tree.
set -euo pipefail

SRC="${1:-/home/deploy/smtp}"
if [ ! -d "$SRC" ]; then
  echo "smtp tree not found: $SRC" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y \
  postfix postfix-pcre libsasl2-modules sasl2-bin \
  opendkim opendkim-tools \
  certbot python3-certbot-nginx \
  iptables curl ca-certificates

echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string mail.droidje.com" | debconf-set-selections

install -d -m 0755 /opt/navix-smtp /etc/navix-smtp /var/lib/navix-smtp
install -m 0755 "$SRC/apply.sh" /usr/local/sbin/navix-smtp-apply
install -d -m 0755 /etc/opendkim/keys/mail.droidje.com
install -d -m 0755 /var/www/html

install -m 0644 "$SRC/postfix/main.cf" /etc/postfix/main.cf
install -m 0644 "$SRC/postfix/master.cf" /etc/postfix/master.cf
install -d -m 0755 /etc/postfix/sasl
install -m 0644 "$SRC/postfix/sasl/smtpd.conf" /etc/postfix/sasl/smtpd.conf

install -m 0644 "$SRC/opendkim/opendkim.conf" /etc/opendkim.conf
install -m 0644 "$SRC/opendkim/KeyTable" /etc/opendkim/KeyTable
install -m 0644 "$SRC/opendkim/SigningTable" /etc/opendkim/SigningTable
install -m 0644 "$SRC/opendkim/TrustedHosts" /etc/opendkim/TrustedHosts

install -d -m 0755 /opt/navix-smtp/watchdog
install -m 0755 "$SRC/watchdog/watchdog.py" /opt/navix-smtp/watchdog/watchdog.py
install -m 0644 "$SRC/watchdog/navix-smtp-watchdog.service" /etc/systemd/system/navix-smtp-watchdog.service

if [ -f "$SRC/nginx/mail.droidje.com.conf" ]; then
  install -m 0644 "$SRC/nginx/mail.droidje.com.conf" /etc/nginx/sites-available/mail.droidje.com
  ln -sfn /etc/nginx/sites-available/mail.droidje.com /etc/nginx/sites-enabled/mail.droidje.com
  nginx -t
  systemctl reload nginx
fi

if [ ! -f /etc/letsencrypt/live/mail.droidje.com/fullchain.pem ]; then
  certbot certonly --webroot -w /var/www/html \
    -d mail.droidje.com \
    --agree-tos --register-unsafely-without-email --non-interactive \
    || certbot certonly --nginx -d mail.droidje.com \
      --agree-tos --register-unsafely-without-email --non-interactive
fi

if [ ! -f /etc/opendkim/keys/mail.droidje.com/navix.private ]; then
  opendkim-genkey -b 2048 -d mail.droidje.com -D /etc/opendkim/keys/mail.droidje.com -s navix -v
fi
chown -R opendkim:opendkim /etc/opendkim /etc/opendkim.conf
chmod 600 /etc/opendkim/keys/mail.droidje.com/navix.private
usermod -a -G opendkim postfix || true
if [ -f /etc/default/opendkim ]; then
  sed -i 's|^#\\?SOCKET=.*|SOCKET="inet:8891@127.0.0.1"|' /etc/default/opendkim
fi
cp /etc/opendkim/keys/mail.droidje.com/navix.txt /etc/navix-smtp/dkim-navix.txt
chmod 644 /etc/navix-smtp/dkim-navix.txt

if [ ! -f /etc/navix-smtp/sasl.env ]; then
  sasl_pass="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
  printf 'SMTP_USER=navix-sys@mail.droidje.com\nSMTP_PASSWORD=%s\n' "$sasl_pass" > /etc/navix-smtp/sasl.env
  chmod 600 /etc/navix-smtp/sasl.env
fi
# shellcheck disable=SC1091
source /etc/navix-smtp/sasl.env
printf '%s\n' "$SMTP_PASSWORD" | saslpasswd2 -c -p -u mail.droidje.com "$SMTP_USER"
if [ -f /etc/sasldb2 ]; then
  chown root:postfix /etc/sasldb2
  chmod 640 /etc/sasldb2
  install -d -m 0755 /var/spool/postfix/etc
  cp -a /etc/sasldb2 /var/spool/postfix/etc/sasldb2
  chown root:postfix /var/spool/postfix/etc/sasldb2
fi
install -d -m 0755 /var/spool/postfix/etc/sasl
cp /etc/postfix/sasl/smtpd.conf /var/spool/postfix/etc/sasl/smtpd.conf

if [ ! -f /etc/navix-smtp/watchdog.env ]; then
  token="$(openssl rand -hex 24)"
  cat > /etc/navix-smtp/watchdog.env <<ENV
WATCHDOG_LISTEN=127.0.0.1
WATCHDOG_PORT=8587
WATCHDOG_TOKEN=${token}
WATCHDOG_INTERVAL_SEC=15
WATCHDOG_FAIL_THRESHOLD=3
WATCHDOG_SUCCESS_THRESHOLD=3
WATCHDOG_BEAT_STALE_SEC=45
WATCHDOG_STATE_PATH=/var/lib/navix-smtp/watchdog-state.json
ENV
  chmod 600 /etc/navix-smtp/watchdog.env
fi

newaliases >/dev/null || true
systemctl daemon-reload
systemctl enable --now opendkim
# Ubuntu ships a dummy postfix.service; the real instance is postfix@-.
postfix stop || true
systemctl restart postfix@- || systemctl restart postfix
systemctl enable --now navix-smtp-watchdog
systemctl restart opendkim
systemctl restart navix-smtp-watchdog
sleep 1

echo "APPLY_OK hostname=mail.droidje.com"
if [ -f /etc/navix-smtp/dkim-navix.txt ]; then
  echo "DKIM_RECORD_BEGIN"
  cat /etc/navix-smtp/dkim-navix.txt
  echo "DKIM_RECORD_END"
fi
curl -fsS http://127.0.0.1:8587/health || true
echo
