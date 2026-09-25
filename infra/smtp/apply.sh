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

# --- OpenRouter mirror -------------------------------------------------------
# Independent nginx vhost mirroring https://openrouter.ai for the prod API
# (Jev), so LLM calls egress from this EU host. Shares nothing with the mail
# stack: no postfix/opendkim/watchdog/hysteria state is read or restarted
# here. Secrets live only in /etc/navix-smtp (0600/0640), never in the repo;
# a tree may carry secrets/openrouter.key to (re)seed them (manual deploy).
# Without a seed key and without existing host includes the vhost is left
# uninstalled so CI trees without the key stay green.
if [ -f "$SRC/nginx/openrouter-mirror.conf" ]; then
  MIRROR_MAP=/etc/navix-smtp/openrouter-mirror.map.nginx
  MIRROR_UPSTREAM=/etc/navix-smtp/openrouter-mirror.upstream.nginx
  MIRROR_ENV=/etc/navix-smtp/openrouter-mirror.env
  MIRROR_SKIP=0
  if [ -f "$SRC/secrets/openrouter.key" ]; then
    # Token precedence: explicit seed in the tree, else keep the host token,
    # else generate one.
    if [ -f "$SRC/secrets/proxy.token" ]; then
      mirror_token="$(tr -d "\r\n\t " < "$SRC/secrets/proxy.token")"
    elif [ -f "$MIRROR_ENV" ]; then
      # shellcheck disable=SC1090
      . "$MIRROR_ENV"
      mirror_token="${PROXY_TOKEN:-}"
    else
      mirror_token="$(openssl rand -hex 32)"
    fi
    mirror_key="$(tr -d "\r\n\t " < "$SRC/secrets/openrouter.key")"
    if [ -z "$mirror_key" ]; then
      echo "openrouter-mirror: seed key file is empty" >&2
      exit 2
    fi
    printf 'PROXY_TOKEN=%s\nOPENROUTER_API_KEY=%s\n' "$mirror_token" "$mirror_key" > "$MIRROR_ENV"
    unset mirror_key
    # shellcheck disable=SC1090
    . "$MIRROR_ENV"
    {
      # The 64-hex token exceeds the default 64-byte map hash bucket.
      printf 'map_hash_bucket_size 128;\n'
      printf 'map $http_x_proxy_token $openrouter_authorized { default 0; "%s" 1; }\n' "$PROXY_TOKEN"
    } > "$MIRROR_MAP"
    {
      printf 'proxy_set_header Authorization "Bearer %s";\n' "$OPENROUTER_API_KEY"
      printf 'proxy_set_header HTTP-Referer "https://navix.droidje.com";\n'
      printf 'proxy_set_header X-Title "Navix Smart Router";\n'
    } > "$MIRROR_UPSTREAM"
    unset PROXY_TOKEN OPENROUTER_API_KEY mirror_token
  elif [ -f "$SRC/secrets/proxy.token" ] && [ -f "$MIRROR_ENV" ] && [ -f "$MIRROR_MAP" ] && [ -f "$MIRROR_UPSTREAM" ]; then
    # Rotate the proxy token without touching the key include; the env keeps
    # the OpenRouter key it already holds.
    mirror_token="$(tr -d "\r\n\t " < "$SRC/secrets/proxy.token")"
    mirror_key="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$MIRROR_ENV" | head -1)"
    printf 'PROXY_TOKEN=%s\nOPENROUTER_API_KEY=%s\n' "$mirror_token" "$mirror_key" > "$MIRROR_ENV"
    {
      # The 64-hex token exceeds the default 64-byte map hash bucket.
      printf 'map_hash_bucket_size 128;\n'
      printf 'map $http_x_proxy_token $openrouter_authorized { default 0; "%s" 1; }\n' "$mirror_token"
    } > "$MIRROR_MAP"
    unset mirror_token mirror_key
  elif [ ! -f "$MIRROR_MAP" ] || [ ! -f "$MIRROR_UPSTREAM" ]; then
    echo "openrouter-mirror: no seed key in tree and no host includes yet; leaving the vhost uninstalled"
    MIRROR_SKIP=1
  fi
  if [ "$MIRROR_SKIP" = 0 ]; then
    chown root:www-data "$MIRROR_MAP" "$MIRROR_UPSTREAM"
    chmod 640 "$MIRROR_MAP" "$MIRROR_UPSTREAM"
    chmod 600 "$MIRROR_ENV"
    # The ACME vhost must serve the HTTP-01 challenge before the certificate
    # can be issued; the 443 vhost joins the config only once the certificate
    # exists (a stale 443 symlink without a cert would fail nginx -t and block
    # the challenge reload).
    if [ ! -f /etc/letsencrypt/live/openrouter.droidje.com/fullchain.pem ]; then
      rm -f /etc/nginx/sites-enabled/openrouter-mirror.conf
    fi
    install -m 0644 "$SRC/nginx/openrouter-mirror-acme.conf" /etc/nginx/sites-available/openrouter-mirror-acme.conf
    ln -sfn /etc/nginx/sites-available/openrouter-mirror-acme.conf /etc/nginx/sites-enabled/openrouter-mirror-acme.conf
    if [ ! -f /etc/letsencrypt/live/openrouter.droidje.com/fullchain.pem ]; then
      nginx -t
      systemctl reload nginx
      if ! certbot certonly --webroot -w /var/www/html \
        -d openrouter.droidje.com \
        --agree-tos --register-unsafely-without-email --non-interactive; then
        echo "openrouter-mirror: certificate issuance failed; 443 vhost left unconfigured" >&2
      fi
    fi
    if [ -f /etc/letsencrypt/live/openrouter.droidje.com/fullchain.pem ]; then
      install -m 0644 "$SRC/nginx/openrouter-mirror.conf" /etc/nginx/sites-available/openrouter-mirror.conf
      ln -sfn /etc/nginx/sites-available/openrouter-mirror.conf /etc/nginx/sites-enabled/openrouter-mirror.conf
      nginx -t
      systemctl reload nginx
      echo "OPENROUTER_MIRROR_OK endpoint=https://openrouter.droidje.com"
    else
      echo "openrouter-mirror: no certificate; mirror not activated" >&2
    fi
  fi
fi
# --- end OpenRouter mirror ---------------------------------------------------

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
