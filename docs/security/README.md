# Security

## Defaults

- This phase is designed for **local execution**.
- The OpenCode runtime is a separate container; the factory only talks to it
  over HTTP.
- The workflow owns state, commits, pushes, and PR creation. The TriggerWatcher
  only enqueues jobs. Agents cannot declare work finished.
- The Reviewer and Planner are read-only; the Builder can edit; QA can only edit
  test files.

## Webapp authentication

- The webapp uses stable NextAuth v4 (`next-auth@4.24.15`) with JWT sessions.
- Users can sign in with email/password or any configured OAuth2 provider:
  Google, GitHub, Apple, Microsoft Entra ID (`azure-ad` in NextAuth) and GitLab.
  Only providers with `AUTH_<PROVIDER>_ID` and `AUTH_<PROVIDER>_SECRET` appear
  on `/login` and `/register`.
- Credentials passwords are hashed with scrypt. OAuth profiles are linked to
  local accounts only when the provider confirms the email (`email_verified`,
  or a provider-managed verified address such as GitHub/GitLab/Microsoft).
  A user may have a password plus several OAuth identities.
- Accounts live in `users`; OAuth links live in `user_identities`
  (`WEB_DATABASE_URL`, or `DATABASE_URL` as a fallback).
- Sessions are encrypted NextAuth JWT cookies, `HttpOnly` and `SameSite=Lax`.
  `WEB_AUTH_SECRET` (or `NEXTAUTH_SECRET`) encrypts them and must be at least 32
  characters. Rotate it to invalidate every session.
- `web/proxy.ts` (Next.js 16 Proxy) validates the JWT and rejects unauthenticated
  page/API requests before they reach a route handler. Pages and route handlers
  verify the session again with `getServerSession`.
- Set `NEXTAUTH_URL` to the public origin (`http://localhost:8080` locally) and
  register the matching `.../api/auth/callback/<provider>` URLs in each provider.
  `AUTH_TRUST_HOST=true` lets Auth.js use the forwarded host behind a proxy.
- Set `WEB_REGISTRATION_CODE` to require an invite code for **email/password**
  registration. OAuth sign-up is governed by the provider app; restrict it at
  the provider if the deployment must be closed.
- Login attempts are rate-limited in memory (single webapp instance).
- The webapp proxies `/api/*` to the factory API with `FACTORY_API_TOKEN`; the
  browser never sees that token. `FACTORY_API_TOKEN` is mandatory and is checked
  on every factory route, including `/` and `/health`.
- Set `WEB_COOKIE_SECURE=true` (or `NEXTAUTH_URL=https://...`) when serving the
  webapp over HTTPS.

## Data isolation between users

- Every run stores `owner_user_id` in PostgreSQL. `GET /api/runs` only returns
  runs owned by the requesting user, and `GET /api/runs/:id` returns `404` when
  the run belongs to someone else.
- Artifacts, events and processed feedback are always read through a run that
  was already checked for ownership; they are not exposed by any unscoped
  endpoint.
- The webapp forwards `X-Factory-User-Id` from the verified NextAuth session.
  The header is set server-side in the `/api/*` proxy and never copied from the
  browser. The factory API also requires the service bearer token, so a browser
  cannot call it directly.
- The unique index for active runs is now `(owner_user_id, ticket_card_id)`, so
  two users can queue the same issue without seeing each other's run. Runs
  created before ownership existed (and not backfilled) are ownerless and
  invisible to the API.
- The worker, TriggerWatcher and job queue intentionally operate across all
  users; they never serve user data. Isolation is enforced at the API/store
  boundary, not with PostgreSQL Row-Level Security.

## Secrets

- `.env` contains the GitHub token, provider key, OpenCode password,
  `FACTORY_API_TOKEN`, `WEB_AUTH_SECRET` and any OAuth client secrets. It is
  gitignored and should stay at `600` permissions.
- Never commit `.env`. Never use `git add -f .env`.
- Tokens are not written to logs or `.git/config`.
- If a token is shared through chat, logs, or screenshots, rotate it.
- The `opencode` container does not receive `GITHUB_TOKEN`, `DATABASE_URL`,
  `FACTORY_API_TOKEN`, `WEB_AUTH_SECRET` or OAuth client secrets.
- The webapp receives `FACTORY_API_TOKEN`, database credentials for its own
  `users`/`user_identities` tables (`WEB_DATABASE_URL` can point to a
  least-privilege role), and OAuth client credentials.
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

- The factory API is bound to `127.0.0.1` by default and requires
  `Authorization: Bearer $FACTORY_API_TOKEN` on every route.
- The webapp is bound to `127.0.0.1` by default and requires a signed-in session.
- OpenCode port `4096` is not published.
- If you expose the webapp/API, set `FACTORY_API_TOKEN` and `WEB_AUTH_SECRET`,
  enable `WEB_COOKIE_SECURE` behind HTTPS, and consider `WEB_REGISTRATION_CODE`.
- Use a GitHub token restricted to the target repos. Fine-grained PATs cannot
  access private repos owned by another personal account, even as a collaborator;
  use a classic `repo` token in that case.
- Change the local PostgreSQL password if this is not a local-only install.

## Known limits

- A single worker, one run at a time.
- No multi-tenant isolation; accounts share the same factory runs.
- Session revocation requires rotating `WEB_AUTH_SECRET`; individual sessions
  are not stored server-side.
- The login rate limiter is in-memory and per webapp instance.
- GitHub/GitLab/Microsoft addresses are treated as verified because those
  providers expose managed addresses without an `email_verified` claim.
- Auto-merge requires a real `APPROVED` review; the factory's same-user token
  cannot self-approve, so use a bot/App or another reviewer.
- Old worktrees and branches are not cleaned up automatically.

See [Architecture](../architecture.md) for runtime isolation details and
[Local testing](../local-testing/README.md) for the operational checks.
