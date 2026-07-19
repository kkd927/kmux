#!/bin/sh

set -eu

umask 077

runtime_root=/run/kmux-ssh
mkdir -p /run/sshd "$runtime_root" /var/log/kmux-ssh

machine_id=${KMUX_NODE_MACHINE_ID:-}
case "$machine_id" in
  *[!0-9a-f]* | "")
    echo "KMUX_NODE_MACHINE_ID must be a non-empty lowercase hexadecimal value" >&2
    exit 64
    ;;
esac
if [ "${#machine_id}" -ne 32 ]; then
  echo "KMUX_NODE_MACHINE_ID must contain exactly 32 hexadecimal characters" >&2
  exit 64
fi
printf '%s\n' "$machine_id" > /etc/machine-id
chmod 0444 /etc/machine-id

host_key="$runtime_root/ssh_host_ed25519_key"
if [ ! -f "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
fi
chmod 0600 "$host_key"
chmod 0644 "$host_key.pub"

mkdir -p /var/lib/kmux-local /run/kmux-users
chmod 0755 /var/lib/kmux-local /run/kmux-users

for account in kmux kmux-alt; do
  account_home=$(getent passwd "$account" | cut -d: -f6)
  mkdir -p "$account_home"
  chown "$account:$account" "$account_home"
  if [ "$account" = "kmux-alt" ] && [ ! -e "$account_home/.zshrc" ]; then
    : > "$account_home/.zshrc"
    chown "$account:$account" "$account_home/.zshrc"
    chmod 0600 "$account_home/.zshrc"
  fi
  mkdir -p "/var/lib/kmux-local/$account" "/run/kmux-users/$account"
  chown "$account:$account" "/var/lib/kmux-local/$account" "/run/kmux-users/$account"
  chmod 0700 "/var/lib/kmux-local/$account" "/run/kmux-users/$account"
  key_file="/etc/ssh/authorized_keys/$account"
  if [ -f "$key_file" ]; then
    chown root:root "$key_file"
    chmod 0644 "$key_file"
  fi
done

effective_config="$runtime_root/sshd_config"
cp /etc/ssh/sshd_config "$effective_config"
if [ "${KMUX_DISABLE_SFTP:-0}" = "1" ]; then
  printf '%s\n' 'Subsystem sftp /bin/false' >> "$effective_config"
else
  printf '%s\n' 'Subsystem sftp internal-sftp' >> "$effective_config"
fi

log_file=/var/log/kmux-ssh/sshd.log
: > "$log_file"
chmod 0600 "$log_file"

socat TCP-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork EXEC:/bin/cat &

exec /usr/sbin/sshd -D -e -f "$effective_config" -E "$log_file"
