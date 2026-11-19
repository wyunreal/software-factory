# Security

## Defaults

- This phase is designed for **local execution**.
- The OpenCode runtime is a separate container; the factory only talks to it
  over HTTP.
- The workflow owns state, commits, pushes, and PR creation. The TriggerWatcher
  only enqueues jobs. Agents cannot declare work finished.
- The Reviewer and Planner are read-only; the Builder can edit; QA can only edit
  test files.

## Secrets

- `.env` contains the GitHub token, provider key, and OpenCode password. It is
  gitignored and should stay at `600` permissions.
- Never commit `.env`. Never use `git add -f .env`.
- Tokens are not written to logs or `.git/config`.
- If a token is shared through chat, logs, or screenshots, rotate it.
- The `opencode` container does not receive `GITHUB_TOKEN` or `DATABASE_URL`.
  The webapp only receives `FACTORY_API_TOKEN`.
- The `factory` container does receive GitHub and database credentials, because
  it performs git and persistence work.

## Trust boundaries

`FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD` are hints for the agents. Setup, build
and test commands run inside the OpenCode container, which has provider
credentials but no GitHub or database credentials. Only point the factory at
trusted repositories; a hostile repo could read the provider key.

For multi-user or public deployments, move setup/test execution to a runner
without secrets and add stronger sandboxing.

## Exposure

- The factory API is bound to `127.0.0.1` by default.
- The webapp is bound to `127.0.0.1` by default.
- OpenCode port `4096` is not published.
- If you expose the webapp/API, set `FACTORY_API_TOKEN`.
- Use a GitHub token restricted to the target repos. Fine-grained PATs cannot
  access private repos owned by another personal account, even as a collaborator;
  use a classic `repo` token in that case.
- Change the local PostgreSQL password if this is not a local-only install.

## Known limits

- A single worker, one run at a time.
- No multi-tenant isolation.
- Auto-merge requires a real `APPROVED` review; the factory's same-user token
  cannot self-approve, so use a bot/App or another reviewer.
- Old worktrees and branches are not cleaned up automatically.

See [Architecture](../architecture.md) for runtime isolation details and
[Local testing](../local-testing/README.md) for the operational checks.
