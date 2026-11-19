# Local testing

## 1. Fast tests

```bash
bun install
bun test
bun run typecheck
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
docker compose exec factory bun run scripts/opencode-check.ts
```

Paths must be under `/config` and `/data`. `opencode-check` prints the URL and
fails if `FACTORY_OPENCODE_URL` is missing instead of assuming `127.0.0.1:4096`.

## 4. Validate GitHub

```bash
docker compose exec factory bun run scripts/github-check.ts
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

Only for changing the orchestrator with Bun on the host. Normal use needs only
`docker compose up`.

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:TU_PASSWORD@127.0.0.1:15432/factory \
bun run src/index.ts
```

`.factory-dev` is mounted at the same absolute path in the OpenCode container,
so host-created worktrees are visible to agents. Do not run the Compose
`factory` service at the same time as the host process: two workers would share
the database.

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
| `GitHub ... 401` | invalid token | regenerate the PAT |
| `GitHub ... 403` | missing permissions | grant Issues, Contents, Pull requests |
| `GitHub ... 404` | bad repo or no access | check repo/issue URL |
| `Repository mismatch` | issue and repo differ | use the issue's repo |
| `Issue #N is closed` | issue closed | use an open issue |
| Webapp 502 | factory down | `docker compose ps`; check logs |
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
