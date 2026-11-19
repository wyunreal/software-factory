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

`.env` must include `FACTORY_API_TOKEN` and `WEB_AUTH_SECRET` (generate each
with `openssl rand -hex 32`); Compose refuses to start without them. OAuth
providers are optional; set `AUTH_<PROVIDER>_ID`/`_SECRET` to enable them.

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

Open the webapp at <http://localhost:8080> and create an account at
<http://localhost:8080/register>. You can register with email/password or use
any OAuth2 provider configured in `.env`. Every webapp page and API request
requires a signed-in session. Use `localhost` rather than `127.0.0.1` for OAuth
so the callback URL matches.

## Start a run

Fill in the webapp:

- **Repository**: `https://github.com/owner/app`
- **Issue URL**: `https://github.com/owner/app/issues/123`
- **Base branch**: usually `main`
- Optional: setup/test command hints for this run only

The factory validates that repo and issue match, fetches the issue, clones the
repo, creates a worktree, and enqueues the run. The agents then inspect the repo
and decide how to build and test.

The repo does not go in the issue: the webapp passes it explicitly.

## Toolchain

The **Builder** inspects the repository (manifests, lockfiles, README) and
installs dependencies, builds and tests with its native toolchain. The
**Verifier** inspects the worktree, decides how to verify the change, runs the
checks the project uses, and returns a structured result.

`FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD`, plus the per-run advanced options, are
optional hints for the agents. The factory never executes them. If the project
has no tests, the gate is skipped.

## GitHub token

Use a **fine-grained PAT** and select only the target repository:

```text
Repository access → Only select repositories → your-repo
```

Classic PATs with the `repo` scope cannot be restricted per repo. If the repo is
in an organization that restricts fine-grained tokens, the token may need owner
approval.

> **Fine-grained tokens and personal repos:** a fine-grained PAT cannot access a
> private repository owned by **another personal account**, even when its owner
> is a collaborator. If the target repo belongs to a different user, use a classic
> PAT with the `repo` scope, or move the repo to an organization.

## Next

- [Configuration](../configuration/README.md)
- [Local testing](../local-testing/README.md)
- [Operations](../operations/README.md)
