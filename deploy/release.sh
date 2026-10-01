#!/usr/bin/env bash
# Deploys one commit of atmin-inc/review: build it beside the running release, switch
# /opt/atmin-review/current, restart, and switch back if the service does not come up healthy.
# Run as root (the deploy user may run exactly this through sudo): release.sh <40-character commit>
# `release.sh runners` only applies ATMIN_REVIEW_RUNNERS from service.env to the live release.
set -euo pipefail
root=/opt/atmin-review
log() { echo "release: $*"; }

# This service's own runners: ATMIN_REVIEW_RUNNERS in service.env, default 2. Runners past the
# count are stopped; a stop or restart lets each finish the review it holds.
runners() {
  local count
  count="$(sed -n 's/^ATMIN_REVIEW_RUNNERS=//p' /etc/atmin-review/service.env)"; count="${count:-2}"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count <= 32 )) || { log "ATMIN_REVIEW_RUNNERS must be 0 to 32, not '$count'"; exit 1; }
  install -m 0644 "$root/current/deploy/atmin-review-runner@.service" /etc/systemd/system/atmin-review-runner@.service
  systemctl daemon-reload
  for i in $(seq 1 "$count"); do
    systemctl enable --quiet "atmin-review-runner@hosted-$i"
    systemctl restart --no-block "atmin-review-runner@hosted-$i"
  done
  for unit in $(systemctl list-units --all --plain --no-legend 'atmin-review-runner@*' | awk '{print $1}') \
              $(systemctl list-unit-files --plain --no-legend 'atmin-review-runner@*' | awk '{print $1}'); do
    [[ "$unit" =~ ^atmin-review-runner@hosted-([0-9]+)\.service$ ]] || continue
    if (( BASH_REMATCH[1] > count )); then systemctl disable --quiet "$unit"; systemctl stop --no-block "$unit"; fi
  done
  log "$count runners (each finishes its current review before restarting)"
}
if [[ "${1:-}" == runners ]]; then runners; exit 0; fi

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: release.sh <40-character commit sha> | runners" >&2; exit 2; }
repo="$root/repo.git"
release="$root/releases/$sha"
config="$(sed -n 's/^ATMIN_REVIEW_CONFIG=//p' /etc/atmin-review/service.env)"
state="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stateDirectory)' "$config")"
port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "$config")"

# The worker refuses reviews below 2048 MB free; do not deploy into that.
free_mb="$(df -Pm "$state" | awk 'NR==2 {print $4}')"
if (( free_mb < 3072 )); then log "only ${free_mb} MB free on $state; not deploying"; exit 1; fi

[[ -d "$repo" ]] || git clone --bare --quiet https://github.com/atmin-inc/review "$repo"
git -C "$repo" fetch --quiet origin '+refs/heads/main:refs/heads/main'
git -C "$repo" merge-base --is-ancestor "$sha" main || { log "$sha is not on main; not deploying"; exit 1; }

if [[ ! -f "$release/.built" ]]; then
  rm -rf "$release"; mkdir -p "$release"
  git -C "$repo" archive "$sha" | tar -x -C "$release"
  (cd "$release" && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm run build:web)
  [[ -f "$release/web/dist/index.html" ]] || { log "dashboard UI did not build"; exit 1; }
  touch "$release/.built"
fi

previous="$(readlink -f "$root/current" || true)"
switch() { ln -sfn "$1" "$root/current.next" && mv -T "$root/current.next" "$root/current"; }
switch "$release"
systemctl restart atmin-review
healthy=no
for _ in $(seq 1 30); do
  sleep 1
  if [[ "$(curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" || true)" == ok ]]; then healthy=yes; break; fi
done
if [[ "$healthy" != yes ]]; then
  journalctl -u atmin-review --since "-2min" --no-pager | tail -n 40 || true
  if [[ -n "$previous" && -d "$previous" ]]; then
    log "not healthy; switching back to $(basename "$previous")"
    switch "$previous"; systemctl restart atmin-review
  fi
  exit 1
fi
if journalctl -u atmin-review --since "-1min" --no-pager | grep -q 'dashboard UI not built'; then log "warning: dashboard UI not built"; fi
log "deployed $sha (previous $(basename "${previous:-none}"))"
runners
# Keep the five newest releases for rollback.
ls -1dt "$root"/releases/*/ | tail -n +6 | xargs -r rm -rf
