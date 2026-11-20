# Getting started

## Requirements

- Docker + Docker Compose.
- A GitHub repository with Issues enabled.
- A GitHub **Personal Access Token** with:
  - **Issues**: read/write
  - **Contents**: read/write
  - **Pull requests**: read/write
  - **Metadata**: read (automatic)
- Model provider credentials. For Ollama Cloud: `OLLAMA_API_KEY` from
  <https://ollama.com/settings/keys>.

The base image includes Git, Node.js, npm, curl, and ripgrep. If the target repo needs
Python, C++, Go, or another toolchain, extend the `Dockerfile`. Agents detect the
project's native toolchain inside the worktree.

## Your local OpenCode is not touched

The factory runs its own OpenCode server in Docker, as a sibling of the
orchestrator. It never reuses your local configuration or runtime.

| Resource | Location |
| --- | --- |
| Runtime config | `/config/opencode` inside the container (read-only) |
| Agent profiles | `./squads/software-development/agents` mounted at `/config/opencode/agents` |
| Data, sessions, auth | Docker volume `software-factory_factory-data`, under `/data/opencode` |
| Process home | `/data/opencode/home` |
| Server port | `4096` internal; not published to the host |
| Credentials | `OPENCODE_SERVER_PASSWORD` + provider variables from `.env` |

The Compose stack does not mount `~/.config/opencode`,
`~/.local/share/opencode`, or `~/.opencode`, and it does not run `opencode` on
the host. The orchestrator only talks HTTP to the container.

Verify it:

```bash
docker compose exec opencode sh -lc 'echo "config=$XDG_CONFIG_HOME"; opencode debug paths'
```

All paths should be under `/config` or `/data`. Authenticate the isolated
runtime with:

```bash
docker compose exec opencode opencode auth login
```

That writes to the factory volume, not your local config.

## First start

```bash
cp .env.example .env
$EDITOR .env

docker compose up --build -d
docker compose ps
docker compose logs -f factory
```

`.env` must include `FACTORY_API_TOKEN`, `WEB_AUTH_SECRET` and
`GITHUB_APP_WEBHOOK_SECRET` (generate each with `openssl rand -hex 32`); Compose
refuses to start without them. It also needs the GitHub App credentials
(`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `_PATH`, and `GITHUB_APP_SLUG`).
OAuth providers are optional; set `AUTH_<PROVIDER>_ID`/`_SECRET` to enable them.

Compose starts four services: `postgres`, `opencode`, `factory`, and `web`. No
manual OpenCode process is needed.

| Service | Purpose | Host port |
| --- | --- | --- |
| `postgres` | state, artifacts, events | none |
| `opencode` | isolated agent runtime | none |
| `factory` | orchestrator and API | `127.0.0.1:3000` (`FACTORY_HOST_PORT`) |
| `web` | Next.js webapp | `127.0.0.1:8080` (`WEB_HOST_PORT`) |

Check health:

```bash
curl -s -H "Authorization: Bearer $FACTORY_API_TOKEN" \
  http://127.0.0.1:13000/health | jq
docker compose exec factory npm run opencode-check
```

Open the webapp at <https://web.factory.warias.app> and create an account at
`/register`. You can register with email/password or use any OAuth2 provider
configured in `.env`. Then create a project with a name and its GitHub
repository. If the GitHub App is not installed on that repository, the webapp
offers the installation flow. Every webapp page and API request requires a
signed-in session.

For PR activity, configure the GitHub App webhook once to
`https://web.factory.warias.app/api/github/webhook` with
`GITHUB_APP_WEBHOOK_SECRET`. Set the App Setup URL to
`https://web.factory.warias.app/api/github/install/callback`. Subscribe to pull
requests, reviews, review comments, issue comments, check suites, check runs and
commit statuses. Local development without a public URL can set
`FACTORY_PR_POLLING=true` as a fallback.

## Start a run

Select a project in the webapp and fill in:

- **Issue URL**: `https://github.com/owner/app/issues/123` — it must belong to
  the project's repository.
- **Base branch**: usually `main`
- Optional: setup/test command hints for this run only

The factory validates that the issue belongs to the project repository, fetches
the issue, clones the repo, creates a worktree, and enqueues the run. The agents
then inspect the repo and decide how to build and test.

## Toolchain

The **Builder** inspects the repository (manifests, lockfiles, README) and
installs dependencies, builds and tests with its native toolchain. The
**Verifier** inspects the worktree, decides how to verify the change, runs the
checks the project uses, and returns a structured result.

`FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD`, plus the per-run advanced options, are
optional hints for the agents. The factory never executes them. If the project
has no tests, the gate is skipped.

## GitHub App

The factory operates as a GitHub App, not as a personal token. Create the App
once under the factory account or organization:

- **Homepage URL**: `https://web.factory.warias.app`
- **Webhook URL**: `https://web.factory.warias.app/api/github/webhook`
- **Setup URL**: `https://web.factory.warias.app/api/github/install/callback`
- **Webhook secret**: `GITHUB_APP_WEBHOOK_SECRET`
- **Repository permissions**: Metadata read; Issues read/write; Contents
  read/write; Pull requests read/write; Checks read; Commit statuses read.
- **Events**: Pull requests, Pull request reviews, Pull request review comments,
  Issue comments, Check suites, Check runs, Commit statuses.

Users install the App only on the repositories they want to use, choosing
**Only select repositories**. The App receives installation tokens for those
repositories; it cannot access the rest. No PAT or per-repo webhook is needed.

Store the App ID, slug and private key in `.env` (or mount the PEM and set
`GITHUB_APP_PRIVATE_KEY_PATH`). The private key is a high-value secret: keep it
out of git and out of the Docker image. For `.env`, the easiest form is
`GITHUB_APP_PRIVATE_KEY_BASE64="$(base64 -w0 github-app.pem)"`.

## Next

- [Configuration](../configuration/README.md)
- [Local testing](../local-testing/README.md)
- [Operations](../operations/README.md)
