#!/usr/bin/env bash
# One-time setup of an Ubuntu 24.04 host for atmin review. Run as root:
#   install.sh <state directory>... 
# The state directories are the pilot config's stateDirectory (and anything else the worker
# writes, such as an old pilot's directory). Keep the paths a moved server already used:
# the job database records them.
set -euo pipefail
(( $# >= 1 )) || { echo "usage: install.sh <state directory>..." >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"

# Node 24, git, gh (source capture calls `gh api`), Caddy, Bubblewrap for local checks.
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git bubblewrap debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -q
apt-get install -y -q nodejs gh caddy

id atmin-review >/dev/null 2>&1 || useradd --system --home-dir /var/lib/atmin-review --shell /usr/sbin/nologin atmin-review
install -d -m 0755 /opt/atmin-review /opt/atmin-review/releases
install -d -m 0750 -g atmin-review /etc/atmin-review
install -d -m 0700 /var/backups/atmin-review
for state in "$@"; do install -d -m 0700 -o atmin-review -g atmin-review "$state"; done
install -m 0755 "$here/release.sh" /opt/atmin-review/release.sh
install -m 0644 "$here/atmin-review.service" /etc/systemd/system/atmin-review.service
install -d /etc/systemd/system/atmin-review.service.d
{ echo '[Service]'; for state in "$@"; do echo "ReadWritePaths=$state"; done; } > /etc/systemd/system/atmin-review.service.d/state.conf
install -m 0644 "$here/Caddyfile" /etc/caddy/Caddyfile

# The deploy user GitHub Actions signs in as. It may run release.sh as root and nothing else.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys; chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 0600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(root) NOPASSWD: /opt/atmin-review/release.sh' > /etc/sudoers.d/atmin-review-deploy
chmod 0440 /etc/sudoers.d/atmin-review-deploy
visudo -cf /etc/sudoers.d/atmin-review-deploy

systemctl daemon-reload
systemctl enable atmin-review
cat <<NEXT
Installed. Before the first deploy:
  1. Put the pilot config, the GitHub App private key and the dashboard config under /etc/atmin-review
     (group atmin-review, mode 0640), and write /etc/atmin-review/service.env (mode 0640) with
     ATMIN_REVIEW_CONFIG=<pilot config path>, the keys the service already uses,
     ATMIN_RUNNER_POOL_TOKEN=\$(openssl rand -hex 32) (the service and its runners share it), and
     optionally ATMIN_REVIEW_RUNNERS=<count> (default 2: reviews that can run at once on our key).
  2. Set ATMIN_REVIEW_PORT=<pilot config port> for Caddy: systemctl edit caddy, then [Service] Environment=ATMIN_REVIEW_PORT=...
     and systemctl restart caddy.
  3. Add the GitHub Actions deploy key to /home/deploy/.ssh/authorized_keys.
  4. Run: sudo /opt/atmin-review/release.sh <commit on main>
NEXT
