# Local testing

## 1. Fast tests

```bash
npm install
npm test
npm run typecheck
```

Covers the state machine, issue parser, configuration, GitHub Issues adapter
(mocked API), and the workflow with in-memory doubles. No agents or local
OpenCode involved.

## 2. Start the isolated stack

```bash
cp .env.example .env
$EDITOR .env
docker compose up --build -d
docker compose ps
docker compose logs -f opencode factory
```

The first start builds the image and starts the isolated OpenCode server. The
target repo is cloned into `factory-data` when the first run starts.

## 3. Verify isolation

```bash
docker compose exec opencode sh -lc 'opencode debug paths'
docker compose exec factory npm run opencode-check
```

Paths must be under `/config` and `/data`. `opencode-check` prints the URL and
fails if `FACTORY_OPENCODE_URL` is missing instead of assuming `127.0.0.1:4096`.

## 4. Validate GitHub

```bash
docker compose exec factory npm run github-check
```

It validates the repo, creates missing labels, and lists issues that would be
claimed. In webapp mode this validation happens per run.

## 5. End-to-end without a PR

Set:

```env
FACTORY_DELIVERY_MODE=local
```

1. Open <http://127.0.0.1:8080>.
2. Enter:
   - Repository: `https://github.com/owner/app`
   - Issue: `https://github.com/owner/app/issues/123`
   - Base branch: `main`
3. Click **Start development**.
4. Watch:

```bash
docker compose logs -f factory
curl -s http://127.0.0.1:13000/api/runs | jq
```

5. Inspect the run:

```bash
RUN_ID=$(curl -s http://127.0.0.1:13000/api/runs | jq -r '.data[0].id')
curl -s "http://127.0.0.1:13000/api/runs/$RUN_ID" \
  | jq '{state: .data.state, repoUrl: .data.repoUrl, worktree: .data.worktree, artifacts: [.data.artifacts[].name]}'
```

6. Inspect the worktree:

```bash
docker compose exec factory sh -lc \
  'cd /data/worktrees/* && git log --oneline --decorate && git diff main...HEAD --stat'
```

The issue should end in `factory:in-review` with a factory comment.

## 6. End-to-end with a PR

Set:

```env
FACTORY_DELIVERY_MODE=github
```

Recreate and start a new run:

```bash
docker compose up -d --force-recreate factory
```

The PR appears in the issue's repo with the plan, builder report, QA, tests,
review, `Closes #<issue>`, and a `factory/<ticket>-<run>` branch.

Merge closes the issue; the factory marks the run `DONE` on the next sync.

## 7. Host development

Only for changing the orchestrator with Node on the host. Normal use needs only
`docker compose up`.

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:TU_PASSWORD@127.0.0.1:15432/factory \
npm run dev
```

`.factory-dev` is mounted at the same absolute path in the OpenCode container,
so host-created worktrees are visible to agents. Do not run the Compose
`factory` service at the same time as the host process: two workers would share
the database.

The webapp is a Next.js app under `web/`. To run it on the host against a local
factory API:

```bash
cd web
npm install
DATABASE_URL=postgres://factory:TU_PASSWORD@127.0.0.1:15432/factory \
WEB_AUTH_SECRET="$(openssl rand -hex 32)" \
NEXTAUTH_URL=http://localhost:8080 \
FACTORY_API_URL=http://127.0.0.1:13000 \
FACTORY_API_TOKEN=el-mismo-valor-que-en-el-factory \
GITHUB_APP_SLUG=tu-app-slug \
GITHUB_APP_WEBHOOK_SECRET=el-secreto-de-la-app \
npm run dev
```

It listens on <http://localhost:8080>. Create an account at `/register`, then
create a project with a GitHub repository and launch issues inside it. The
webapp proxies `/api/*` server-side and adds `FACTORY_API_TOKEN`; the factory API
requires it on every route.

The factory host process also needs `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` (or `_PATH`) to resolve installation tokens.

GitHub events:

- In production the App webhook is configured once at
  `https://web.factory.warias.app/api/github/webhook`; no per-repo webhook is
  needed. Users install the App only on the repositories they choose.
- For local testing, use a tunnel such as `cloudflared` or `smee.io` and set the
  App webhook URL to the tunnel URL. The Setup URL can point to
  `https://<tunnel>/api/github/install/callback`.
- Without a public URL, set `FACTORY_PR_POLLING=true` to use the old periodic
  scan as a fallback. The default is event-driven (`false`).

Webapp tests:

```bash
npm --prefix web test
```

## 8. Cleanup

```bash
docker compose down          # keeps DB and worktrees
docker compose down -v       # deletes all factory state
```

`down -v` removes credentials, sessions, clones, and worktrees in the isolated
volume. It does not touch your local OpenCode.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `OpenCode ... 401` | password mismatch | use the same `.env`; recreate services |
| `GitHub App ... 401` | invalid App ID/private key | check `GITHUB_APP_ID` and private key |
| `GitHub App ... 403` | App lacks permissions | review App permissions |
| `GitHub App ... 404` | App not installed on repo | install it from the webapp |
| `Repository mismatch` | issue and project differ | use the project's repo |
| `Issue #N is closed` | issue closed | use an open issue |
| Webapp 502 | factory down | `docker compose ps`; check logs |
| Webapp 500 / `NO_SECRET` | `WEB_AUTH_SECRET` empty | set it in `.env`; restart web |
| Webapp 500 after login | `NEXTAUTH_URL` empty | set `NEXTAUTH_URL=https://web.factory.warias.app` |
| Webhook `401` | secret/signature mismatch | use the same `GITHUB_APP_WEBHOOK_SECRET` in `.env` and the GitHub App |
| Webhook `502` | factory down | `docker compose ps`; check factory logs |
| PR events not processed | polling off and no App webhook | configure the App webhook or set `FACTORY_PR_POLLING=true` |
| `redirect_uri_mismatch` | OAuth callback differs | register `${NEXTAUTH_URL}/api/auth/callback/<provider>` |
| OAuth provider not listed | provider env incomplete | set `AUTH_<PROVIDER>_ID` and `_SECRET`; restart web |
| Issue not processed | state label or `factory:skip` | check labels and `/api/runs` |
| `Setup command failed` | missing toolchain | extend `Dockerfile` or fix setup command |
| Tests always red | missing deps/command | test inside `docker compose exec factory sh -lc '<cmd>'` |
| `Builder produced no changes` | agent changed nothing | inspect `build` artifact |
| Port 3000 busy | another process | set `FACTORY_HOST_PORT=13000` |
| Port 8080 busy | another process | set `WEB_HOST_PORT=8081` |
| `Location not found` | worktree not visible | use the shared `/data` volume; don't mount host paths |

## Next

- [Configuration](../configuration/README.md)
- [Operations](../operations/README.md)
