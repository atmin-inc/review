# Deploying atmin review

One host runs the worker (webhooks, dashboard, reviews) behind Caddy. GitHub Actions deploys
every commit on `main` that passed CI; the host builds it beside the running release and
switches back by itself if the new one does not answer `/healthz` within 30 s.

| File | Where it goes |
|---|---|
| `install.sh` | Run once as root on a fresh Ubuntu 24.04 host. |
| `atmin-review.service` | `/etc/systemd/system/` (install.sh). |
| `Caddyfile` | `/etc/caddy/Caddyfile` (install.sh); needs `ATMIN_REVIEW_PORT`. |
| `release.sh` | `/opt/atmin-review/release.sh`; the deploy user may run only this, as root. |
| `../.github/workflows/deploy.yml` | Runs after "review alpha" passes on a push to `main`, or by hand with a commit. |

Layout on the host: releases in `/opt/atmin-review/releases/<commit>` (five kept),
`/opt/atmin-review/current` points at the live one, secrets and configs in `/etc/atmin-review`
(`service.env` sets `ATMIN_REVIEW_CONFIG`), state where the pilot config says.

GitHub settings (repository → Settings → Environments → `production`):
- `DEPLOY_HOST`: the host name or address.
- `DEPLOY_SSH_KEY`: a private key whose public half is in `/home/deploy/.ssh/authorized_keys`.
- `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan <host>`, checked against the host's own keys.

Moving from an existing server: stop the old service, copy the state directories and
`/etc/atmin-review` with `rsync -a` to the same paths (the job database records absolute run
paths), run `install.sh` with those state directories, deploy the commit the old server ran,
check `/healthz` on the new host, then point `review.atmin.ai` at it. The GitHub App's webhook
URL does not change.
