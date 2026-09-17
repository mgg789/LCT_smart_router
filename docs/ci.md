# CI/CD — SourceCraft and the public gate

> Living notes for the pipeline. The contour itself is described in
> [runbook.md](./runbook.md) and [architecture.md](./architecture.md).

SourceCraft reads [`.sourcecraft/ci.yaml`](../.sourcecraft/ci.yaml) from the
repository **default branch** (`main`). Until that file is on `main`, push and
pull-request triggers do not start.

## Workflows

| Workflow | When | What |
|---|---|---|
| `ci` | push to `dev`; pull request targeting `dev` or `main` | lint, tests, secret scan, mojibake |
| `cd` | push to `main` (after merge) | the same checks, then compose build + deploy |

A red `ci` run on a pull request into `main` is the merge condition. Branch
protection in [`.sourcecraft/branches.yaml`](../.sourcecraft/branches.yaml)
blocks direct push and force-push to `main`, and force-push / deletion of `dev`.

### `ci` tasks

- **lint** — `pnpm lint` (Biome) and `ruff check core`.
- **test-js** — web Vitest + typecheck; API `node:test` against a throwaway
  `pgvector/pgvector:pg17` container (`scripts/ci/run-js-tests.sh`).
- **test-core** — `pytest core/tests`. Official-region golden benchmarks are
  **not** in this job (too heavy for every push).
- **secrets** — `gitleaks detect` with [`.gitleaks.toml`](../.gitleaks.toml).
- **mojibake** — `node scripts/ci/check-mojibake.mjs` (UTF-8 / cp1251-as-UTF-8).

`pnpm smoke` is still the local / demo contour gate (AGENTS.md §11.1). It is
destructive and is not part of this pipeline.

## Deploy

`cd` SSHs to the MGG host with the same compose path as the `mgg-server-deploy`
skill: fast-forward `main` in `/home/mgg/navix`, then

```bash
docker compose -f docker-compose.yml up -d --build --remove-orphans
```

The root [docker-compose.yml](../docker-compose.yml) includes
`infra/docker-compose.yml` so the skill can find the contour without knowing
about `infra/`.

Healthchecks after `up`:

- public gate `https://navix.droidje.com/`
- loopback `http://127.0.0.1:18080/health/live` (this host already publishes
  another app on `:8000`; the System Layer stays on the compose network at
  `api:8000`, only the host publish port changed)

The dashboard is the `web` container on `127.0.0.1:5173`; host nginx terminates
TLS for `navix.droidje.com` and proxies there. `web` already forwards `/api/`
to `api:8000`. On this host `.env` must remap occupied ports:

- `API_PORT=127.0.0.1:18080` — host `:8000` is taken
- `ROUTER_PORT=18100` — host `127.0.0.1:8100` is taken (`binom-landing-test`)

Compose still talks `api:8000` and `router:8100` on the internal network.
This remains a demo contour: `NODE_ENV=development` and
`AUTH_DEV_EXPOSE_CODES=true` — the application refuses to combine exposed
login codes with `production`.

### Secrets and host one-offs

Create a SourceCraft repository secret named **`MGG_DEPLOY_SSH_KEY`**: the
private half of a deploy-only SSH key whose public half is in
`mgg@178.140.207.217` `~/.ssh/authorized_keys`. Do not commit the key, do not
put it on the board, do not write it to team memory.

The MGG host also needs a **read-only SourceCraft deploy key** so
`git pull --ff-only origin main` works in `/home/mgg/navix`. Put the public
half in the repository Deploy keys; the private half stays at
`~mgg/.ssh/navix_sourcecraft` (see `~mgg/.ssh/config`).

`scripts/ci/bootstrap-navix-host.sh` creates the SourceCraft pull key and a
server-only `.env` (random DB and dispatcher passwords, loopback API on
`18080`, router publish on `18100`). Dispatcher credentials live only in
`/home/mgg/navix/.env`.

Host nginx is not written by CI. After the clone exists, on the server:

```bash
sudo bash /home/mgg/navix/scripts/ci/install-navix-nginx.sh
```

That installs [infra/nginx/navix.droidje.com.conf](../infra/nginx/navix.droidje.com.conf)
(`proxy_pass http://127.0.0.1:5173`) and asks certbot for the certificate. `mgg`
is in `sudo` but the password is interactive.

The secret is mounted only on the `cd` / `deploy` task (push to `main`), never
on pull-request pipelines.

Manual deploy from a machine that already has SSH to the host:

```powershell
& "$env:USERPROFILE\.cursor\skills\mgg-server-deploy\scripts\deploy-mgg-app.ps1" `
  -AppDir "/home/mgg/navix" `
  -BranchOrRef "main" `
  -HealthcheckUrl "https://navix.droidje.com/"
```

## Activation order

1. Merge `feat/infra-sourcecraft-ci` into `dev`.
2. Put the deploy key on the server and the private half into SourceCraft
   **before** the first merge to `main`.
3. Team-lead merge `dev` → `main`. That commit activates the triggers and
   should run `cd`.
