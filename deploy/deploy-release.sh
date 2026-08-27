#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag is required}"
archive_url="${2:?archive URL is required}"
checksum_url="${3:?checksum URL is required}"
archive="remi-x86_64-unknown-linux-gnu.tar.gz"
release_dir="/opt/remi/releases/${tag}"
temporary_dir="$(mktemp -d)"
previous_release="$(readlink -f /opt/remi/current 2>/dev/null || true)"

cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT

curl --fail --location --retry 5 --retry-all-errors --output "$temporary_dir/$archive" "$archive_url"
curl --fail --location --retry 5 --retry-all-errors --output "$temporary_dir/$archive.sha256" "$checksum_url"
(
  cd "$temporary_dir"
  sha256sum --check "$archive.sha256"
  mkdir package
  tar -xzf "$archive" -C package
)

install -d -m 0755 "$release_dir"
install -m 0755 "$temporary_dir/package/remi/remi" "$release_dir/remi"
install -d -m 0755 "$release_dir/web"
cp -R "$temporary_dir/package/remi/web/." "$release_dir/web/"
install -m 0644 "$temporary_dir/package/remi/remi.service" /etc/systemd/system/remi.service
install -m 0644 "$temporary_dir/package/remi/Caddyfile" /etc/caddy/Caddyfile
chown -R remi:remi /var/lib/remi
ln -sfnT "$release_dir" /opt/remi/current
systemctl daemon-reload
systemctl enable --now remi caddy
systemctl restart remi caddy

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3000/healthz | grep -qx ok; then
    find /opt/remi/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs --no-run-if-empty rm -rf
    exit 0
  fi
  sleep 2
done

if [ -n "$previous_release" ]; then
  ln -sfnT "$previous_release" /opt/remi/current
  systemctl restart remi caddy
fi
systemctl status remi --no-pager
exit 1
