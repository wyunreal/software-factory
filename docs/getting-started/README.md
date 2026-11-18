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

The base image includes Git, Bun, curl, and ripgrep. If the target repo needs
Python, C++, Go, or another toolchain, extend the `Dockerfile` or use commands
that work in the image. Commands come from the target repo's `.factory.yml`.

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

Compose starts four services: `postgres`, `opencode`, `factory`, and `web`. No
manual OpenCode process is needed.

| Service | Purpose | Host port |
| --- | --- | --- |
| `postgres` | state, artifacts, events | none |
| `opencode` | isolated agent runtime | none |
| `factory` | orchestrator and API | `127.0.0.1:3000` (`FACTORY_HOST_PORT`) |
| `web` | webapp | `127.0.0.1:8080` (`WEB_HOST_PORT`) |

Check health:

```bash
curl -s http://127.0.0.1:13000/health | jq
docker compose exec factory bun run scripts/opencode-check.ts
```

Open the webapp at <http://127.0.0.1:8080>.

## Start a run

Fill in the webapp:

- **Repository**: `https://github.com/owner/app`
- **Issue URL**: `https://github.com/owner/app/issues/123`
- **Base branch**: usually `main`
- Optional: setup/test commands for this run only

The factory validates that repo and issue match, fetches the issue, clones the
repo, creates a worktree, reads `.factory.yml`, and runs the squad.

The repo does not go in the issue: the webapp passes it explicitly.

## `.factory.yml`

Build and test commands are read from the target repo, on the base branch:

```yaml
# .factory.yml
setup: bun install
test: bun test
```

If the file is absent, `FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD` are used as
fallbacks. With no test command, the deterministic gate is skipped.

## GitHub token

Use a **fine-grained PAT** and select only the target repository:

```text
Repository access → Only select repositories → your-repo
```

Classic PATs with the `repo` scope cannot be restricted per repo. If the repo is
in an organization that restricts fine-grained tokens, the token may need owner
approval.

With a single-repo token, also set:

```env
FACTORY_ALLOWED_REPOS=owner/your-repo
```

## Repository allowlist

```env
FACTORY_ALLOWED_REPOS=owner/app,owner/other
```

Empty means any repo the token can access. Use an allowlist in shared
environments.

## Optional polling

The webapp is the primary path. To let the factory discover issues on its own:

```env
GITHUB_REPOSITORY=owner/app
FACTORY_REPO_URL=https://github.com/owner/app.git
```

Open issues without a state label are then processed automatically. Without
these variables, only webapp/API runs are executed.

## Next

- [Configuration](../configuration/README.md)
- [Local testing](../local-testing/README.md)
- [Operations](../operations/README.md)
