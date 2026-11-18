# Software Factory

An AI-agent software factory. It turns **GitHub Issues** into Pull Requests by
running a squad of agents on [OpenCode](https://opencode.ai), while a
deterministic orchestrator keeps control of the workflow.

The "Factory Manager" is that orchestrator, not an LLM: models produce artifacts
and recommendations, but they do not decide ticket state or publish changes on
their own.

```
GitHub Issues + code
(target repo, not the factory)
      │
      ▼
Orchestrator ──► Planner ──► Builder ──► QA ──► Tests ──► Reviewer ──► PR
      │             │           │          │        │          │
      └─────────────┴───────────┴──────────┴──────────┴──────────┘
                artifacts + state in PostgreSQL
```

## Current state: Phase 1

Implemented and runnable with Docker Compose:

- A single ephemeral squad, one ticket at a time (model A).
- **Webapp** included to start a run by passing **repo + issue URL**.
- Backlog in **GitHub Issues** in the target repo; the repo is resolved at
  runtime.
- Optional automatic polling if you configure
  `GITHUB_REPOSITORY`/`FACTORY_REPO_URL`.
- Claim via labels (`factory:in-progress`), comments, and issue closure when the
  PR is merged.
- Agents: **Planner**, **Builder**, **QA**, **Reviewer** on OpenCode.
- Isolation via **git worktree** and a `factory/<ticket>-<run>` branch.
- Per-repo build/test commands via `.factory.yml` (or global fallback).
- Deterministic quality gate and reviewer verdict.
- Bounded rework (`FACTORY_MAX_REWORK`).
- Delivery: push + **Pull Request** in the issue's repo (or `local` mode without
  push/PR).
- State, artifacts, and events persisted in **PostgreSQL**.
- HTTP API and webapp to inspect runs and force a tick.

Out of scope for this phase: parallelism, distributed queue, advanced dashboard,
budgets, and lease-based recovery. See [`docs/phases.md`](docs/phases.md).

## Requirements

- Docker + Docker Compose.
- A GitHub repository with Issues enabled.
- A GitHub **Personal Access Token** with:
  - `Issues: read/write` (read issues, create labels, comment)
  - `Contents: read/write` (clone and push)
  - `Pull requests: read/write` (create PRs)
  - For a classic PAT, the `repo` scope covers everything.
- Model provider credentials. For Ollama Cloud:
  `OLLAMA_API_KEY` (from <https://ollama.com/settings/keys>).

The base image includes Git, Bun, curl, and ripgrep. If the target repo uses
Python, C++, Go, or a Node runtime of its own, add that toolchain to the
`Dockerfile` or use commands that work with what is available. Commands come from
`.factory.yml`.

## Isolation: your local OpenCode is untouched

The factory runs **its own OpenCode server inside Docker**. Docker Compose starts
it as the `opencode` service, a sibling container to the orchestrator; the factory
only talks to it over HTTP. It never reuses or modifies the OpenCode on your
machine:

| Resource | Where it lives |
| --- | --- |
| Runtime config | `/config/opencode` inside the container (read-only) |
| Factory agents | `./squads/software-development/agents` mounted at `/config/opencode/agents` |
| Data, sessions, auth | Docker volume `software-factory_factory-data`, under `/data/opencode` |
| Process home | `/data/opencode/home` |
| Server port | `4096` internal; **not published to the host** |
| Credentials | `OPENCODE_SERVER_PASSWORD` + provider variables from `.env` |

Specifically, the compose file **does not** mount `~/.config/opencode`,
`~/.local/share/opencode`, or `~/.opencode`. It also does not run the `opencode`
binary on the host: the orchestrator only talks HTTP to the container.

You can verify this with:

```bash
docker compose exec opencode sh -lc 'echo "config=$XDG_CONFIG_HOME"; opencode debug paths'
```

It should show `config /config/opencode`, `data /data/opencode/data/opencode`,
`cache`, and `state` under `/data`. If any path points to `/root` or a host
directory, something has been mounted incorrectly.

To authenticate the isolated runtime:

```bash
docker compose exec opencode opencode auth login
```

That writes to the factory volume, not to your local configuration.

## Quick start

```bash
cp .env.example .env
$EDITOR .env

docker compose up --build -d
docker compose ps
docker compose logs -f factory
```

`docker compose up` starts **four services**: `postgres`, `opencode` (the
isolated agent runtime), `factory` (the orchestrator), and `web` (the webapp).
You do not need to start OpenCode separately or use your machine's OpenCode.

```
┌─────────────────────── Docker internal network ────────────────────┐
│  postgres  ◄──── factory ────HTTP───►  opencode (isolated runtime) │
│                      ▲                                             │
│                      │ /api/*                                      │
│                    web ◄──── browser                                │
└─────────────────────────────────────────────────────────────────────┘
        │                              │
 127.0.0.1:8080                  127.0.0.1:13000
 (webapp)                       (factory API)
```

| Service | What it is | Host port |
| --- | --- | --- |
| `postgres` | state, artifacts, events | none |
| `opencode` | isolated agent runtime | none |
| `factory` | orchestrator and API | `127.0.0.1:3000` (`FACTORY_HOST_PORT`) |
| `web` | webapp to start runs | `127.0.0.1:8080` (`WEB_HOST_PORT`) |

The factory waits for `opencode` to be healthy before starting. The runtime's
`4096` port is internal to the Compose network; it is not published and cannot
conflict with your local OpenCode.

Check that everything is healthy:

```bash
curl -s http://127.0.0.1:13000/health | jq
docker compose exec factory bun run scripts/opencode-check.ts
```

Open the webapp at:

```text
http://127.0.0.1:8080
```

If you use interactive authentication instead of environment variables:

```bash
docker compose exec opencode opencode auth login
```

## Starting a run from the webapp

The webapp is at <http://127.0.0.1:8080>. Fill in:

- **Repository**: `https://github.com/owner/app`
- **Issue URL**: `https://github.com/owner/app/issues/123`
- **Base branch**: usually `main`
- Optional: setup/test commands for this run only

The factory:

1. validates that the issue and repo match;
2. fetches the issue with `GITHUB_TOKEN`;
3. clones the repo, creates an isolated worktree, and reads `.factory.yml`;
4. runs Planner → Builder → QA → Tests → Reviewer;
5. comments on/labels the issue and, if `FACTORY_DELIVERY_MODE=github`, opens the
   PR.

You do not put the repo in the issue: the webapp passes it explicitly.

### `.factory.yml` in the target repo

Build/test commands are read from the repository itself, on the base branch:

```yaml
# .factory.yml
setup: bun install
test: bun test
```

If the file does not exist, `FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD` are used
as fallbacks. If there is no test command, the deterministic gate is skipped.

This way the repo owns its toolchain and you do not hardcode per-project
commands in the engine.

### GitHub token

`GITHUB_TOKEN` is required. Permissions:

- **Issues**: read/write
- **Contents**: read/write
- **Pull requests**: read/write
- **Metadata**: read (automatic)

**Yes, it can be restricted to a single repo.** Use a **fine-grained PAT**:

```text
Repository access → Only select repositories → your-repo
```

A classic PAT with the `repo` scope grants access to every repo the user can
reach; it cannot be restricted per repository. For production/local use with a
single repo, use fine-grained tokens.

If the repo belongs to an organization that restricts fine-grained PATs, the
token may require approval from the organization owner.

If you restrict the token to one repo, also set:

```env
FACTORY_ALLOWED_REPOS=owner/your-repo
```

This makes the webapp reject any other repo before attempting to clone it.

### Repository allowlist

To limit which repos the webapp can use:

```env
FACTORY_ALLOWED_REPOS=owner/app,owner/other
```

Empty = any repo the token can access. This is convenient locally; in a shared
environment, define the allowlist.

### Optional polling

The webapp is the main path. If you also want the factory to discover issues on
its own, define a default repo:

```env
GITHUB_REPOSITORY=owner/app
FACTORY_REPO_URL=https://github.com/owner/app.git
```

With that, open issues without a state label are processed automatically.
Without those variables, only runs started from the webapp or API are executed.

### Model and provider

The model is **not configured in the webapp**. It is defined statically in `.env`
and applies to every session when you start/recreate the factory.

For Ollama Cloud:

```env
OLLAMA_API_KEY=your_ollama_api_key
FACTORY_MODEL=ollama-cloud/deepseek-v4.1-flash:1017
```

- Get the API key at <https://ollama.com/settings/keys>.
- OpenCode ships the `ollama-cloud` provider with base URL
  `https://ollama.com/v1`; you do not need to define a provider manually.
- The key is passed to the `opencode` container through Compose environment
  variables (from `.env`); it is not baked into the image.
- If the key is missing or the model does not exist, the factory fails at
  startup with `Model ollama-cloud/... is not available`.
- To change models, edit `FACTORY_MODEL` and recreate:

```bash
docker compose up -d --force-recreate factory
```

Alternatives:

```env
# OpenCode free model, no API key
FACTORY_MODEL=opencode/hy4-flash-free

# Anthropic
FACTORY_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=...
```

### Auto-merge

The PR is created only when the LLM Reviewer returns `PASS`. Auto-merge is a
second, human gate on top of the already-created PR:

```env
FACTORY_AUTO_MERGE=true
FACTORY_MERGE_METHOD=squash   # merge | squash | rebase
```

The factory merges when:

- there is at least one GitHub review in `APPROVED` state;
- no reviewer has `CHANGES_REQUESTED` as their latest decisive review;
- the PR is open, not a draft, and GitHub considers it `mergeable` with
  `mergeable_state = clean`;
- the repository's branch protection requirements are satisfied.

If anything fails, the PR stays in `HUMAN_REVIEW` and is not merged. The merge
uses the current head SHA, so it cannot merge a different commit from the one
that was reviewed.

Auto-merge is checked on every polling cycle. The factory's LLM review does not
count as a GitHub review; a real human approval is required.

If the factory uses the same GitHub user as you, GitHub will not let that user
approve its own PR. Use a bot account or a GitHub App for the factory, or a
second reviewer.

### Rework from human review

If a human submits a review with `CHANGES_REQUESTED`, the factory reopens
development on the **same run, branch, and PR**:

```env
FACTORY_REWORK_ON_CHANGES_REQUESTED=true
```

1. Detect the review and its inline comments.
2. Store the feedback as a `feedback` artifact.
3. Move the run to `REWORK` and back to `BUILDING`.
4. The Builder receives the human feedback along with the plan and previous
   artifacts.
5. QA, tests, and the Reviewer run again.
6. Push to the same branch: the PR is updated, not recreated.
7. The factory replies to inline comments and posts a PR comment requesting
   re-review.
8. Auto-merge keeps waiting for an `APPROVED` review.

Reviews are deduplicated by ID and `FACTORY_MAX_REWORK` is respected. When it is
exhausted, the run moves to `BLOCKED`.

### Comment triage

A new PR comment does not reopen development directly: it goes through a triage
agent that decides whether there is real work to do.

```env
FACTORY_TRIAGE_PR_COMMENTS=true
FACTORY_FEEDBACK_USERS=          # empty = OWNER/MEMBER/COLLABORATOR
```

Flow:

```text
comment -> TRIAGING -> NO_ACTION -> HUMAN_REVIEW
                    -> REWORK    -> same branch/PR
```

- `NO_ACTION` for “GOOD”, “thanks”, “LGTM”, or already-resolved comments.
- `REWORK` for bugs, behavior changes, missing tests, or concrete requests.
- Triage can process several comments and decide per comment.
- Factory comments are ignored by ID; comments from disallowed users are also
  ignored.
- `CHANGES_REQUESTED` still goes straight to `REWORK`, without triage.

### The issue

Create an open issue in the target repo. No label is required: an open issue
without a state label and without `factory:skip` is **Ready**.

Example body:

```markdown
Fix login so it rejects empty passwords.

## Acceptance criteria
- [ ] A valid user can sign in
- [ ] Invalid credentials are rejected with 401
- [ ] The session expires after 24 hours
```

Criteria are read from the body; plain `-` lists also work.

Labels used by the factory:

| Label | Meaning |
| --- | --- |
| `factory:in-progress` | the factory has claimed it |
| `factory:in-review` | there is a PR / delivery ready for a human |
| `factory:blocked` | it needs human intervention |
| `factory:skip` | ignore this issue |

Pull requests are ignored automatically: the GitHub issues API returns them
mixed in, but the adapter filters them out.

## Testing locally

### 1. Fast tests, no Docker or OpenCode

```bash
bun install
bun test
bun run typecheck
```

These tests cover the state machine, issue parser, configuration, GitHub Issues
adapter (with a mocked API), and the full workflow with in-memory doubles. They
do not start any agents or touch your OpenCode.

### 2. Start the isolated stack

```bash
cp .env.example .env
$EDITOR .env
docker compose up --build -d
docker compose ps
docker compose logs -f opencode factory
```

The first start builds the image (including Git, Bun, and OpenCode) and starts
the isolated OpenCode server. The target repo is cloned into `factory-data` when
you start the first run. There is no manual “start OpenCode” step: Compose does
it.

### 3. Verify the runtime is isolated

```bash
docker compose exec opencode sh -lc 'opencode debug paths'
docker compose exec factory bun run scripts/opencode-check.ts
```

`debug paths` should show `config` under `/config/opencode` and `data`, `cache`,
and `state` under `/data/opencode`. `opencode-check` prints the URL it is using;
if `FACTORY_OPENCODE_URL` is not set, it fails instead of assuming
`127.0.0.1:4096`.

### 4. Validate GitHub (optional when using the webapp)

If you are going to use automatic polling (with
`GITHUB_REPOSITORY`/`FACTORY_REPO_URL`):

```bash
docker compose exec factory bun run scripts/github-check.ts
```

It should validate the repo, create any missing labels, and list the issues that
would be claimed. In webapp mode you can skip this step; validation happens when
each run starts.

### 5. End-to-end test without publishing a PR

Set `FACTORY_DELIVERY_MODE=local` for this test so it does not push or
create a PR, but still labels and comments on the issue.

1. Open <http://127.0.0.1:8080>.
2. Fill in:
   - Repository: `https://github.com/owner/app`
   - Issue: `https://github.com/owner/app/issues/123`
   - Base branch: `main`
3. Click **Start development**.
4. Watch progress in the webapp or with:

```bash
docker compose logs -f factory
curl -s http://127.0.0.1:13000/api/runs | jq
```

5. Inspect the run and its artifacts:

```bash
RUN_ID=$(curl -s http://127.0.0.1:13000/api/runs | jq -r '.data[0].id')
curl -s "http://127.0.0.1:13000/api/runs/$RUN_ID" \
  | jq '{state: .data.state, repoUrl: .data.repoUrl, worktree: .data.worktree, artifacts: [.data.artifacts[].name]}'
```

6. Inspect the generated work:

```bash
docker compose exec factory sh -lc \
  'cd /data/worktrees/* && git log --oneline --decorate && git diff main...HEAD --stat'
```

7. The issue should end up with `factory:in-review` and a factory comment.

### 6. End-to-end test with a Pull Request

Change to `FACTORY_DELIVERY_MODE=github`:

```bash
docker compose up -d --force-recreate factory
```

Start a new run from the webapp with another issue. When it finishes, a PR should
appear **in the issue's repo**, with:

- the plan, builder report, QA, tests, and review in the body;
- the `Closes #<issue>` reference, so merging closes the issue;
- the `factory/<ticket>-<run>` branch.

The token needs `Contents: write` and `Pull requests: write`.

When the PR is merged and GitHub closes the issue, the factory marks the run as
`DONE` on the next poll.

### 7. Developing the orchestrator on the host

This section is **only** for modifying the orchestrator code by running it with
Bun on your machine. In the normal flow you do not need it: `docker compose up`
already starts OpenCode and the factory.

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:TU_PASSWORD@127.0.0.1:15432/factory \
bun run src/index.ts
```

`compose.dev.yaml` mounts `.factory-dev` into the container at the same absolute
path, so worktrees created by the host process are visible to the agents. Do not
run the Compose `factory` service at the same time as the host process: two
workers would share the same database.

### 8. Cleanup

```bash
docker compose down          # keeps the database and worktrees
docker compose down -v       # deletes all factory state
```

`down -v` removes the `factory-data` volume and, with it, the isolated runtime's
credentials, sessions, clones, and worktrees. It does not affect your local
OpenCode.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `OpenCode ... 401` | password differs between services | use the same `.env`; restart with `docker compose up -d --force-recreate` |
| `GitHub ... 401` | invalid token | regenerate the PAT |
| `GitHub ... 403` | token lacks permissions | grant Issues, Contents, and Pull requests |
| `GitHub ... 404` | repo misspelled or inaccessible | check the repo/issue URL |
| `Repository mismatch` | repo and issue belong to different repos | use the repo where the issue lives |
| `Issue #N is closed` | the issue is already closed | use an open issue |
| Webapp returns 502 | the factory is not up | `docker compose ps` and `docker compose logs factory` |
| Issue is not processed by polling | state label, `factory:skip`, or no default repo | check labels and `/api/runs` |
| `Setup command failed` | missing dependencies or toolchain | extend the `Dockerfile` or fix `FACTORY_SETUP_CMD` |
| Tests always red | missing dependencies or command not present in the image | test with `docker compose exec factory sh -lc '<cmd>'` |
| `Builder produced no changes` | the agent changed nothing | inspect the `build` artifact |
| `Bind for 0.0.0.0:3000 failed` | another process uses port 3000 | set `FACTORY_HOST_PORT=13000` |
| `Bind for 0.0.0.0:8080 failed` | another process uses port 8080 | set `WEB_HOST_PORT=8081` |
| `Location not found` | worktree path not visible from OpenCode | do not mount host paths; use the `/data` volume |

## How a run works

1. The webapp or `POST /api/runs` receives **repo + issue URL** and creates a
   run (`CLAIMED`). Optionally, the poller can discover issues if you configure a
   default repo.
2. The factory validates that issue and repo match, fetches the issue, and
   applies `factory:in-progress` + a comment.
3. It clones the target repo and creates an isolated worktree in the
   `factory-data` volume.
4. It reads `.factory.yml` from the base branch to resolve setup/test.
5. **Planner** explores the repo and produces `plan`.
6. **Builder** implements and leaves changes uncommitted. The orchestrator makes
   the commit; agents are forbidden from rewriting history by prompt and
   permissions.
7. **QA** adds/reviews tests (it may only edit test files).
8. The orchestrator runs the resolved test command. If it fails, it returns to
   `BUILDING` with the output as feedback, up to `FACTORY_MAX_REWORK` times.
9. **Reviewer** reviews the diff and returns `VERDICT: PASS` or `VERDICT: FAIL`.
   A FAIL also consumes a rework cycle.
10. In `DELIVERY` the branch is pushed and a PR is created in the issue's repo,
    with `Closes #<issue>` in the body.
11. The issue is labeled `factory:in-review` and the run stays in
    `HUMAN_REVIEW`. When the PR is merged and the issue is closed, the poller
    moves the run to `DONE`.

State diagram:

```
CLAIMED → PLANNING → PLANNED → BUILDING → QA → TESTING → REVIEWING → DELIVERY
                                   ▲            │           │            │
                                   └── REWORK ◄─┴───────────┘            ▼
                                                                   HUMAN_REVIEW
                                                                     │      │
                                                                     │      └── TRIAGING ──► HUMAN_REVIEW
                                                                     │              └─────► REWORK
                                                                     ▼
                                                                    DONE

Any active state can end in BLOCKED.
```

## Artifacts

Each step leaves an artifact persisted in PostgreSQL and visible through the API:

| Artifact | Producer | Content |
| --- | --- | --- |
| `plan` | Planner | analysis, criteria, tasks, risks |
| `build` | Builder | summary, changes, tests run |
| `qa` | QA | test plan, added tests, result |
| `tests` | Orchestrator | raw output of `FACTORY_TEST_CMD` |
| `review` | Reviewer | verdict and findings |
| `delivery` | Orchestrator | PR URL or branch path in local mode |

Agents communicate through these artifacts, not only through conversation.

## API

The API listens on `127.0.0.1:${FACTORY_HOST_PORT}`. The local `.env` uses
`13000` because 3000 may be taken; adjust it to your own value. If you set
`FACTORY_API_TOKEN`, send `Authorization: Bearer <token>` on `/api/*` routes.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | PostgreSQL, OpenCode, and orchestrator status |
| GET | `/api/status` | orchestrator statistics and flags |
| GET | `/api/runs` | latest runs (`?limit=`) |
| GET | `/api/runs/:id` | run + artifacts + events |
| POST | `/api/runs` | start a run with `repoUrl` + `issueUrl` |
| POST | `/api/tick` | force a polling and work cycle |

Example:

```bash
curl -s -X POST http://127.0.0.1:13000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repoUrl": "https://github.com/owner/app",
    "issueUrl": "https://github.com/owner/app/issues/123",
    "baseBranch": "main"
  }' | jq
```

It optionally accepts `setupCommand` and `testCommand` for that run; otherwise
`.factory.yml`, `FACTORY_SETUP_CMD`, and `FACTORY_TEST_CMD` are used.

## Agents

Profiles live in `squads/software-development/agents/` and are mounted into the
OpenCode container as global agents. They are not written into the target repo.

| Agent | Permissions |
| --- | --- |
| `factory-planner` | read-only (`read`, `glob`, `grep`); no shell or editing |
| `factory-builder` | read, edit, and shell; no subagents |
| `factory-qa` | shell + editing limited to test files |
| `factory-reviewer` | read-only + read-only `git`; no general editing |
| `factory-feedback-triage` | read-only + `git`; decides `NO_ACTION` or `REWORK` |

The orchestrator creates one OpenCode session per step. Agents are persistent
profiles; sessions and worktrees are ephemeral.

## Configuration

All variables are documented in [`.env.example`](.env.example). The most
important ones:

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | — (required) | PAT with Issues, Contents, and Pull requests |
| `GITHUB_REPOSITORY` | empty | repo for automatic polling (optional) |
| `FACTORY_REPO_URL` | empty | polling repo URL (optional) |
| `FACTORY_ALLOWED_REPOS` | empty | comma-separated `owner/repo` allowlist |
| `FACTORY_BASE_BRANCH` | `main` | default base branch |
| `FACTORY_TEST_CMD` | empty | fallback when the repo has no `.factory.yml` |
| `FACTORY_SETUP_CMD` | empty | setup fallback |
| `FACTORY_MAX_REWORK` | `3` | maximum correction cycles |
| `FACTORY_DELIVERY_MODE` | `github` | `github` or `local` |
| `FACTORY_AUTO_MERGE` | `false` | merge PRs with an APPROVED review |
| `FACTORY_MERGE_METHOD` | `squash` | `merge`, `squash`, or `rebase` |
| `FACTORY_REWORK_ON_CHANGES_REQUESTED` | `true` | reopen on CHANGES_REQUESTED |
| `FACTORY_TRIAGE_PR_COMMENTS` | `true` | triage PR comments before rework |
| `FACTORY_FEEDBACK_USERS` | empty | allowlist of logins allowed to give feedback |
| `FACTORY_LABEL_IN_PROGRESS` | `factory:in-progress` | claim label |
| `FACTORY_LABEL_IN_REVIEW` | `factory:in-review` | delivery label |
| `FACTORY_LABEL_BLOCKED` | `factory:blocked` | blocked label |
| `FACTORY_LABEL_READY` | empty | opt-in: only issues with this label |
| `FACTORY_SKIP_LABELS` | `factory:skip` | labels to ignore |
| `FACTORY_MODEL` | default model | `provider/model[#variant]` for all agents |
| `OLLAMA_API_KEY` | empty | Ollama Cloud API key (`ollama-cloud` provider) |
| `FACTORY_OPENCODE_URL` | — (required) | isolated runtime URL; Compose uses `http://opencode:4096` |
| `FACTORY_HOST_PORT` | `3000` | host port for the API |
| `WEB_HOST_PORT` | `8080` | host port for the webapp |
| `POSTGRES_USER` | `factory` | PostgreSQL user |
| `POSTGRES_PASSWORD` | — (required) | PostgreSQL password, read from `.env` |
| `POSTGRES_DB` | `factory` | database |
| `DATABASE_URL` | — (required) | full URL; must use the same password |
| `FACTORY_AUTO_APPROVE_PERMISSIONS` | `true` | answer OpenCode "ask" permissions |

## Project map

| Path | Content |
| --- | --- |
| `src/index.ts` | startup, validation, shutdown |
| `src/orchestrator.ts` | optional polling, claim, worker, closed-issue sync |
| `src/workflow.ts` | pipeline and state transitions |
| `src/api.ts` | HTTP API, including `POST /api/runs` |
| `web/` | webapp to start runs with repo + issue URL |
| `src/domain/` | types, state machine, issue parser |
| `src/backlog/github.ts` | GitHub Issues connector |
| `src/runtime/opencode.ts` | OpenCode HTTP client (sessions, permissions, wait) |
| `src/scm/git.ts` | clone, worktrees, commits, tests, push |
| `src/scm/github.ts` | idempotent Pull Request creation |
| `src/store/` | PostgreSQL and in-memory test store |
| `src/squad/prompts.ts` | role prompts and PR body |
| `squads/software-development/agents/` | agent profiles and permissions |
| `tests/` | unit and workflow tests |
| `docs/` | architecture and phases |
| `compose.yaml` | isolated stack |
| `compose.dev.yaml` | high ports for host development |

## Development

The application runs on Bun and has no runtime dependencies. The recommended
iteration flow is in [Testing locally](#testing-locally):

```bash
bun install
bun test
bun run typecheck
```

To run the orchestrator on the host against the isolated runtime:

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:TU_PASSWORD@127.0.0.1:15432/factory \
bun run src/index.ts
```

`FACTORY_OPENCODE_URL` is required on purpose: the code never assumes
`127.0.0.1:4096`, so a mistake cannot end up using your local OpenCode.

### Adding an agent

1. Create `squads/software-development/agents/factory-<role>.md`.
2. Declare `description`, `mode`, `steps`, and `permissions` in the frontmatter.
3. Add the ID to the verification list in `src/index.ts`.
4. Add its prompt and step in `src/workflow.ts`, with valid transitions in
   `src/domain/state.ts`.
5. Add tests for the new step in `tests/workflow.test.ts`.

### Adding a backlog connector

Implement `BacklogPort` in `src/ports.ts` and wire the adapter in `src/index.ts`.
The workflow does not know about GitHub: it only uses the port. For Jira, Linear,
or Vikunja, follow the pattern in `src/backlog/github.ts`.

## Project skill (local only)

The project's operational knowledge lives in
`.opencode/skills/software-factory/SKILL.md`. It is loaded automatically in
future OpenCode sessions opened in this repository and contains:

- architecture and invariants that must not be broken;
- test and startup commands;
- runtime isolation rules;
- known OpenCode API pitfalls;
- phase status and next steps.

The `.opencode/` directory is intentionally **gitignored and not published** in
the public repository. It is a project-local skill: it does not modify your
global OpenCode configuration or the factory runtime configuration. If you change
the architecture, update the local skill in the same change as the code.

## Security and limits

- The OpenCode container has access to the shared `/data` volume, not the rest of
  the host.
- The Reviewer cannot edit; neither can the Planner. The separation is
  intentional.
- The orchestrator decides transitions, commits, pushes, and PRs. An agent cannot
  declare a ticket finished.
- Tokens are not written to logs or stored in git configuration.
- `.env` is gitignored and should stay at `600` permissions; never commit it.
  If a token is shared through chat, logs, or screenshots, rotate it.
- The `opencode` container does not receive `GITHUB_TOKEN` or `DATABASE_URL`; the
  webapp only receives `FACTORY_API_TOKEN`. The factory does need GitHub/DB.
- `FACTORY_SETUP_CMD`, `FACTORY_TEST_CMD`, and `.factory.yml` commands run in the
  factory container and inherit its environment. Only run trusted repositories
  and configurations.
- The PR stays for human review by default. With `FACTORY_AUTO_MERGE=true`, it is
  only merged after an `APPROVED` review and a `clean` state.
- The GitHub token has write access to the repo: treat it as a secret.
- The webapp/API accepts repos at runtime. If you expose it outside your machine,
  set `FACTORY_ALLOWED_REPOS` and `FACTORY_API_TOKEN`.
- `.factory.yml` is read from the target repo; whoever controls that repo
  controls the commands that run. Do not use untrusted repos.
- The PostgreSQL password in `.env` is a local development value; change it if
  this is not a strictly local installation.
- This phase is intended for local execution. Do not expose the API to the
  Internet or run agents on repositories whose permissions you have not reviewed.
