#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag is required}"
archive_url="${2:?archive URL is required}"
checksum_url="${3:?checksum URL is required}"
archive="remi-x86_64-unknown-linux-musl.tar.gz"
caddy_version="2.11.4"
caddy_archive="caddy_${caddy_version}_linux_amd64.tar.gz"
caddy_sha512="8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9"
release_dir="/opt/remi/releases/${tag}"
temporary_dir="$(mktemp -d)"
previous_release="$(readlink -f /opt/remi/current 2>/dev/null || true)"
if [ ! -d "$previous_release" ]; then
  previous_release=""
fi

cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT

if ! command -v caddy >/dev/null; then
  curl --fail --location --retry 5 --retry-all-errors --output "$temporary_dir/$caddy_archive" "https://github.com/caddyserver/caddy/releases/download/v${caddy_version}/$caddy_archive"
  printf '%s  %s\n' "$caddy_sha512" "$temporary_dir/$caddy_archive" | sha512sum --check
  tar -xzf "$temporary_dir/$caddy_archive" -C "$temporary_dir"
  install -m 0755 "$temporary_dir/caddy" /usr/local/bin/caddy
fi
if ! id remi >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/remi --create-home --shell /sbin/nologin remi
fi
install -d -m 0755 /etc/caddy /etc/remi
install -d -m 0750 -o remi -g remi /var/lib/remi
if [ ! -f /etc/remi/remi.env ]; then
  printf '%s\n' \
    'REMI_BIND=127.0.0.1:3000' \
    'REMI_DATA_DIR=/var/lib/remi' \
    'REMI_WEB_DIR=/opt/remi/current/web' \
    >/etc/remi/remi.env
  chmod 0600 /etc/remi/remi.env
fi

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
install -m 0644 "$temporary_dir/package/remi/caddy.service" /etc/systemd/system/caddy.service
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
