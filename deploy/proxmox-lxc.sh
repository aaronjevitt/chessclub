#!/usr/bin/env bash
# Deploy Chess Club into a Proxmox VE LXC container.
#
# Run on the Proxmox host as root:
#   ./deploy/proxmox-lxc.sh                 create a new container and deploy
#   ./deploy/proxmox-lxc.sh update <CTID>   redeploy the latest code into an existing container
#
# Source code: when run from inside a chessclub checkout, that checkout is copied into the
# container (works for private repos). Otherwise REPO_URL/BRANCH is cloned inside the container.
#
# Settings (environment variables, all optional):
#   CTID              container id                       (default: next free id)
#   CT_HOSTNAME       container hostname                 (default: chessclub)
#   STORAGE           storage for the root disk          (default: local-lvm)
#   TEMPLATE_STORAGE  storage holding CT templates       (default: local)
#   DISK_GB           root disk size in GB               (default: 8)
#   CORES             CPU cores                          (default: 2)
#   MEMORY_MB         RAM in MB                          (default: 1024)
#   SWAP_MB           swap in MB                         (default: 512)
#   BRIDGE            network bridge                     (default: vmbr0)
#   IP                "dhcp" or CIDR, e.g. 192.168.1.50/24 (default: dhcp)
#   GATEWAY           gateway when IP is static          (e.g. 192.168.1.1)
#   VLAN              VLAN tag                           (default: none)
#   CT_PASSWORD       root password for console login    (default: none; use `pct enter`)
#   SSH_KEY_FILE      public key to authorize for root   (default: none)
#   PORT              port the app listens on            (default: 3000)
#   COOKIE_SECURE     1 when served over HTTPS           (default: 0)
#   REPO_URL          git URL when not run from a checkout (default: https://github.com/aaronjevitt/chessclub.git)
#   BRANCH            git branch to deploy               (default: main)
#   SOURCE_DIR        force copying this local directory instead of cloning

set -euo pipefail

CT_HOSTNAME="${CT_HOSTNAME:-chessclub}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-8}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-1024}"
SWAP_MB="${SWAP_MB:-512}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GATEWAY="${GATEWAY:-}"
VLAN="${VLAN:-}"
PORT="${PORT:-3000}"
COOKIE_SECURE="${COOKIE_SECURE:-0}"
# Remember explicit choices so `update` only falls back to the recorded settings for unset ones.
USER_REPO_URL="${REPO_URL:-}"
USER_BRANCH="${BRANCH:-}"
REPO_URL="${REPO_URL:-https://github.com/aaronjevitt/chessclub.git}"
BRANCH="${BRANCH:-main}"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"
{ command -v pct && command -v pveam; } >/dev/null || die "pct/pveam not found — run this on a Proxmox VE host"

# ---------- pick the code source ----------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${SOURCE_DIR:-}" && -f "$SCRIPT_DIR/../package.json" ]] && grep -q '"name": "chessclub"' "$SCRIPT_DIR/../package.json"; then
  SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
if [[ -n "${SOURCE_DIR:-}" ]]; then
  [[ -f "$SOURCE_DIR/package.json" ]] || die "SOURCE_DIR=$SOURCE_DIR does not contain package.json"
  SOURCE_MODE=push
else
  SOURCE_MODE=git
fi

# ---------- provisioning script that runs inside the container ----------

write_provision_script() {
  cat >"$1" <<'PROVISION'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck disable=SC1091
source /root/chessclub-deploy.env

APP_DIR=/opt/chessclub
DATA_DIR=/var/lib/chessclub

echo "--> installing system packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg >/dev/null

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "--> installing Node.js 22"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
echo "--> node $(node -v)"

id chessclub >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin chessclub
install -d -o chessclub -g chessclub -m 0750 "$DATA_DIR"

echo "--> fetching application code ($SOURCE_MODE)"
NEW_DIR="$(mktemp -d /opt/chessclub.new.XXXXXX)"
if [[ "$SOURCE_MODE" == push ]]; then
  tar -xzf /root/chessclub-src.tar.gz -C "$NEW_DIR"
  rm -f /root/chessclub-src.tar.gz
else
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$NEW_DIR"
fi
[[ -f "$NEW_DIR/package.json" ]] || { echo "no package.json in fetched code" >&2; exit 1; }

echo "--> installing dependencies"
(cd "$NEW_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chmod 0755 "$NEW_DIR"

# Swap in the new release; the database lives in $DATA_DIR and is untouched.
if [[ -d "$APP_DIR" ]]; then
  rm -rf "$APP_DIR.old"
  mv "$APP_DIR" "$APP_DIR.old"
fi
mv "$NEW_DIR" "$APP_DIR"

install -d -m 0755 /etc/chessclub
if [[ ! -f /etc/chessclub/chessclub.env ]]; then
  cat >/etc/chessclub/chessclub.env <<EOF
PORT=$PORT
DB_FILE=$DATA_DIR/chessclub.db
COOKIE_SECURE=$COOKIE_SECURE
NODE_ENV=production
EOF
fi
# Remember how this container was deployed so `update` can repeat it.
cat >/etc/chessclub/deploy.env <<EOF
SOURCE_MODE=$SOURCE_MODE
REPO_URL=$REPO_URL
BRANCH=$BRANCH
EOF

cat >/etc/systemd/system/chessclub.service <<'EOF'
[Unit]
Description=Chess Club
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chessclub
Group=chessclub
WorkingDirectory=/opt/chessclub
EnvironmentFile=/etc/chessclub/chessclub.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/chessclub

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet chessclub
systemctl restart chessclub

# shellcheck disable=SC1091
source /etc/chessclub/chessclub.env
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/me" >/dev/null 2>&1; then
    rm -rf "$APP_DIR.old"
    echo "--> chessclub is running on port $PORT"
    exit 0
  fi
  sleep 1
done
echo "chessclub did not come up; recent logs:" >&2
journalctl -u chessclub -n 40 --no-pager >&2 || true
if [[ -d "$APP_DIR.old" ]]; then
  echo "--> rolling back to the previous release" >&2
  rm -rf "$APP_DIR" && mv "$APP_DIR.old" "$APP_DIR" && systemctl restart chessclub
fi
exit 1
PROVISION
}

# ---------- helpers ----------

wait_for_network() {
  local ctid=$1
  info "waiting for network in CT $ctid"
  for _ in $(seq 1 60); do
    if pct exec "$ctid" -- getent hosts deb.debian.org >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  die "container $ctid has no network/DNS after 120s — check BRIDGE/IP/GATEWAY"
}

deploy_into() {
  local ctid=$1 tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  write_provision_script "$tmp/provision.sh"
  {
    printf 'SOURCE_MODE=%q\n' "$SOURCE_MODE"
    printf 'REPO_URL=%q\n' "$REPO_URL"
    printf 'BRANCH=%q\n' "$BRANCH"
    printf 'PORT=%q\n' "$PORT"
    printf 'COOKIE_SECURE=%q\n' "$COOKIE_SECURE"
  } >"$tmp/deploy.env"

  pct push "$ctid" "$tmp/provision.sh" /root/chessclub-provision.sh --perms 0700
  pct push "$ctid" "$tmp/deploy.env" /root/chessclub-deploy.env --perms 0600

  if [[ "$SOURCE_MODE" == push ]]; then
    info "packaging $SOURCE_DIR"
    tar -czf "$tmp/src.tar.gz" -C "$SOURCE_DIR" \
      --exclude=./node_modules --exclude=./data --exclude=./.git --exclude='*.db' --exclude='*.db-*' .
    pct push "$ctid" "$tmp/src.tar.gz" /root/chessclub-src.tar.gz --perms 0600
  else
    info "deploying $REPO_URL ($BRANCH)"
  fi

  info "provisioning CT $ctid"
  pct exec "$ctid" -- bash /root/chessclub-provision.sh
  pct exec "$ctid" -- rm -f /root/chessclub-provision.sh /root/chessclub-deploy.env
}

print_summary() {
  local ctid=$1 addr
  addr="$(pct exec "$ctid" -- hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  info "Chess Club is up in CT $ctid"
  echo "    URL:      http://${addr:-<container-ip>}:$PORT"
  echo "    Logs:     pct exec $ctid -- journalctl -u chessclub -f"
  echo "    Config:   /etc/chessclub/chessclub.env (inside the container)"
  echo "    Database: /var/lib/chessclub/chessclub.db (inside the container)"
  echo "    Update:   $0 update $ctid"
}

# ---------- update mode ----------

if [[ "${1:-}" == update ]]; then
  CTID="${2:-${CTID:-}}"
  [[ -n "$CTID" ]] || die "usage: $0 update <CTID>"
  pct status "$CTID" >/dev/null 2>&1 || die "container $CTID does not exist"
  if [[ "$(pct status "$CTID")" != *running* ]]; then
    info "starting CT $CTID"
    pct start "$CTID"
  fi
  # Unless told otherwise, repeat the source settings recorded at install time.
  if [[ "$SOURCE_MODE" == git ]] && saved="$(pct exec "$CTID" -- cat /etc/chessclub/deploy.env 2>/dev/null)"; then
    saved_repo="$(sed -n 's/^REPO_URL=//p' <<<"$saved")"
    saved_branch="$(sed -n 's/^BRANCH=//p' <<<"$saved")"
    REPO_URL="${USER_REPO_URL:-${saved_repo:-$REPO_URL}}"
    BRANCH="${USER_BRANCH:-${saved_branch:-$BRANCH}}"
  fi
  PORT="$(pct exec "$CTID" -- sed -n 's/^PORT=//p' /etc/chessclub/chessclub.env 2>/dev/null || echo "$PORT")"
  wait_for_network "$CTID"
  deploy_into "$CTID"
  print_summary "$CTID"
  exit 0
fi
[[ $# -eq 0 ]] || die "unknown arguments: $* (usage: $0 [update <CTID>])"

# ---------- create mode ----------

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
if pct status "$CTID" >/dev/null 2>&1; then
  die "container $CTID already exists (use: $0 update $CTID)"
fi

info "looking up a Debian container template"
pveam update >/dev/null || warn "pveam update failed; using the cached template list"
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-13-standard_' | sort -V | tail -n1 || true)"
[[ -n "$TEMPLATE" ]] || TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard_' | sort -V | tail -n1 || true)"
[[ -n "$TEMPLATE" ]] || die "no Debian 12/13 template available from pveam"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  info "downloading $TEMPLATE to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NET="name=eth0,bridge=$BRIDGE,ip=$IP"
if [[ "$IP" != dhcp ]]; then
  [[ "$IP" == */* ]] || die "IP must be 'dhcp' or CIDR notation like 192.168.1.50/24"
  [[ -n "$GATEWAY" ]] && NET+=",gw=$GATEWAY"
fi
[[ -n "$VLAN" ]] && NET+=",tag=$VLAN"

CREATE_ARGS=(
  "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE"
  --hostname "$CT_HOSTNAME"
  --cores "$CORES"
  --memory "$MEMORY_MB"
  --swap "$SWAP_MB"
  --rootfs "$STORAGE:$DISK_GB"
  --net0 "$NET"
  --unprivileged 1
  --features nesting=1
  --onboot 1
  --start 0
  --description "Chess Club — https://github.com/aaronjevitt/chessclub"
)
[[ -n "${CT_PASSWORD:-}" ]] && CREATE_ARGS+=(--password "$CT_PASSWORD")
if [[ -n "${SSH_KEY_FILE:-}" ]]; then
  [[ -f "$SSH_KEY_FILE" ]] || die "SSH_KEY_FILE=$SSH_KEY_FILE not found"
  CREATE_ARGS+=(--ssh-public-keys "$SSH_KEY_FILE")
fi

info "creating CT $CTID ($CT_HOSTNAME) from $TEMPLATE"
pct create "$CTID" "${CREATE_ARGS[@]}"
pct start "$CTID"
wait_for_network "$CTID"
deploy_into "$CTID"
print_summary "$CTID"
