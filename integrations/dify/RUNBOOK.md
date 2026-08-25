# Dify operations runbook — dify.kadindustries.org

## What this session could and could not check

Verified from here:

- `dify.kadindustries.org` resolves to `2606:4700:3037::ac43:b6ee` and
  `2606:4700:3034::6815:3bc1`. Both are Cloudflare anycast addresses, so the
  hostname is fronted by Cloudflare — either an orange-cloud proxy record or a
  Cloudflare Tunnel. Cloudflare's limits therefore apply to every request; see
  [Cloudflare](#cloudflare) below.

Not verified: anything about the instance itself. Outbound HTTPS in this
session goes through a policy-enforcing proxy that refused `CONNECT` to
`dify.kadindustries.org:443` and to `kadindustries.org:443`, so no request ever
reached the origin. Nothing here is a diagnosis of a specific fault — it is the
set of checks and fixes that cover how a Dify deployment on a real domain
actually breaks. Run the healthcheck first and work from what it reports.

## First moves

From anywhere:

```bash
DIFY_API_KEY=app-xxxx ./integrations/dify/deploy/healthcheck.sh
```

On the VM, in the Dify `docker/` directory:

```bash
docker compose ps                      # every service should be Up (healthy)
docker compose logs --tail=200 api     # the API is where real errors surface
docker compose logs --tail=100 nginx
docker compose logs --tail=100 worker  # async jobs: indexing, scheduled runs
docker compose logs --tail=100 plugin_daemon   # Dify 1.x only
```

Two commands settle "is it Dify or is it the edge?":

```bash
# From the VM, bypassing every proxy:
curl -s localhost:8080/console/api/setup

# From outside, through the public name:
curl -s https://dify.kadindustries.org/console/api/setup
```

If the first works and the second does not, the fault is in the proxy,
Cloudflare, or DNS — not in Dify.

## Symptoms

### Console loads, but login or any action fails

The single most common Dify misconfiguration. `CONSOLE_API_URL`,
`CONSOLE_WEB_URL`, `SERVICE_API_URL`, `APP_API_URL`, `APP_WEB_URL` and
`FILES_URL` are baked into the pages Dify serves. If any still says `http://`,
`localhost` or an old address, the browser calls the wrong origin and it
surfaces as CORS errors, mixed-content blocks, or a login that posts into the
void.

Fix: set all six to `https://dify.kadindustries.org` in `docker/.env` (see
`deploy/dify.env.example`), then `docker compose down && docker compose up -d`.
A plain `restart` does not re-render nginx's config from those variables.

### Streaming answers arrive all at once, or appear to hang

Something between the client and Dify is buffering the SSE response. The
healthcheck measures this directly: it reports the time to first byte on a
streaming `/v1/chat-messages` call, and flags anything over 10 seconds.

Check in order:

1. Your own nginx, if you have one in front — it needs `proxy_buffering off`
   on `/v1`, `/console/api` and `/api`. `deploy/nginx-dify.conf` has this.
2. Cloudflare — see below.
3. Any corporate proxy or VPN on the client side.

### 524 on long calls

Cloudflare gives an origin 100 seconds to return the first byte, then answers
524. A blocking `/v1/workflows/run` that takes longer always hits this, however
generous nginx's timeouts are.

Fix, in order of preference:

1. Call workflows in streaming mode. Dify emits `workflow_started` and
   `node_*` events immediately, so the first byte lands well inside 100s.
2. Put the API hostname on a DNS-only record (grey cloud), or split the
   Service API onto its own unproxied hostname.
3. Cloudflare Enterprise, where the timeout is configurable.

Raising `NGINX_PROXY_READ_TIMEOUT` does not help: the limit is Cloudflare's.

### 504 on long calls, no Cloudflare involved

Different limit, different fix. Either nginx gave up
(`NGINX_PROXY_READ_TIMEOUT`, default 3600s) or gunicorn killed the worker
(`GUNICORN_TIMEOUT`, default 360s in `deploy/docker-compose.override.yaml`).
`docker compose logs api` distinguishes them: a killed worker logs a timeout
from gunicorn, an nginx timeout does not appear in the API log at all.

### 413 on upload

Three caps, and the smallest wins:

| Cap | Where | Default |
|---|---|---|
| Cloudflare request body | Cloudflare plan | 100 MB (free/pro) |
| `NGINX_CLIENT_MAX_BODY_SIZE` | `docker/.env` | 15M |
| `UPLOAD_FILE_SIZE_LIMIT` | `docker/.env`, in MB | 15 |

Raise nginx's cap to at least the application limit, and keep both under
Cloudflare's.

### 502 or 503 from the proxy

nginx is up, Dify is not. `docker compose ps` shows which service is down or
unhealthy; `docker compose logs api` says why. After a version upgrade the
usual cause is a pending migration — confirm `MIGRATION_ENABLED=true` and read
the api container's startup log.

### Plugins or model providers fail (Dify 1.x)

`PLUGIN_DAEMON_KEY` and `PLUGIN_DIFY_INNER_API_KEY` must be set and identical
across the `api` and `plugin_daemon` services. When they disagree the daemon
starts fine and every plugin-backed tool fails at call time.

### "Access token is invalid" from the Service API

Per-app key problem, not an instance problem: the key was revoked, belongs to a
different app, or is a console token rather than an `app-...` Service API key.
Regenerate under the app's **API Access** page. `node
integrations/dify/src/doctor.ts` shows which app is failing.

### Model provider credentials all stopped working at once

`SECRET_KEY` changed. It encrypts stored provider credentials, so a new value
makes every saved credential undecryptable. Restore the old `SECRET_KEY` if you
still have it; otherwise re-enter each provider's credentials.

## Cloudflare

The hostname is Cloudflare-fronted, which adds constraints Dify's own config
cannot override:

- **100s to first byte**, then 524. Covered above.
- **Request body cap** — 100 MB on free and pro plans.
- **Response buffering.** Cloudflare streams `text/event-stream` normally, but
  transforms in the request pipeline can defeat it. If the healthcheck reports
  buffering and your origin nginx is clean, test with a DNS-only record to
  confirm Cloudflare is the hop responsible.
- **SSL/TLS mode.** Use Full (strict) with a Cloudflare Origin Certificate. In
  Flexible mode Cloudflare speaks HTTP to the origin while browsers see HTTPS;
  unless `X-Forwarded-Proto` is honoured end to end, Dify generates `http://`
  links and browsers block them.
- **WebSockets** must stay enabled for the console.

## Applying configuration changes

```bash
cd /path/to/dify/docker
cp docker-compose.override.yaml .          # from integrations/dify/deploy/, once
$EDITOR .env                               # keys from deploy/dify.env.example
docker compose down
docker compose up -d
docker compose ps
```

`down` then `up` rather than `restart`: nginx renders its configuration from
`.env` at container start.

## Upgrading

```bash
cd /path/to/dify
git pull
cd docker
docker compose down
docker compose pull
docker compose up -d
docker compose logs -f api        # watch migrations complete
```

Back up first — at minimum the `db` volume and `docker/.env`, which holds
`SECRET_KEY`:

```bash
docker compose exec db pg_dumpall -U postgres > dify-$(date +%F).sql
cp docker/.env docker/.env.backup-$(date +%F)
```

Because `docker-compose.override.yaml` is a separate file, an upgrade that
replaces `docker-compose.yaml` leaves your overrides intact.
