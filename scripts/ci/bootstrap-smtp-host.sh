#!/usr/bin/env bash
# First-time SMTP host users and SSH keys. Secrets stay on the host.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root on the SMTP host" >&2
  exit 2
fi

ops_key="${NAVIX_OPS_PUBKEY:?NAVIX_OPS_PUBKEY is the laptop public key}"
ci_key="${NAVIX_CI_PUBKEY:?NAVIX_CI_PUBKEY is the SourceCraft deploy public key}"

id -u deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 0700 /home/deploy/.ssh /root/.ssh
if id -u mike >/dev/null 2>&1; then
  install -d -m 0700 -o mike -g mike /home/mike/.ssh
fi

append_key() {
  local file="$1"
  local key="$2"
  touch "$file"
  grep -Fqx "$key" "$file" || printf '%s\n' "$key" >> "$file"
}

append_key /root/.ssh/authorized_keys "$ops_key"
append_key /home/deploy/.ssh/authorized_keys "$ops_key"
append_key /home/deploy/.ssh/authorized_keys "$ci_key"
if [ -d /home/mike ]; then
  append_key /home/mike/.ssh/authorized_keys "$ops_key"
  chown -R mike:mike /home/mike/.ssh
  chmod 600 /home/mike/.ssh/authorized_keys
fi
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys

install -d -m 0755 /etc/sudoers.d
cat > /etc/sudoers.d/navix-smtp-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/local/sbin/navix-smtp-apply
SUDO
chmod 440 /etc/sudoers.d/navix-smtp-deploy

# Root password login is how the leaked credential worked. After keys are in
# place, root may only use public keys. Other accounts are unchanged.
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
if [ -f /etc/ssh/sshd_config.d/50-cloud-init.conf ]; then
  sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config.d/50-cloud-init.conf
fi
sshd -t
systemctl reload ssh || systemctl reload sshd

# Replace the leaked root password with a random value that is not stored.
root_pass="$(openssl rand -base64 24)"
echo "root:${root_pass}" | chpasswd
unset root_pass

echo "BOOTSTRAP_OK"
