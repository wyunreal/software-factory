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

- Every project belongs to exactly one user; every run stores both
  `owner_user_id` and `project_id`.
- `GET /api/projects`, `GET /api/runs` and `GET /api/runs/:id` are scoped to the
  authenticated user. A project or run owned by another user is reported as
  `404`.
- `POST /api/runs` requires a `projectId` owned by the caller and rejects issues
  from any other repository.
- Artifacts, events and processed feedback are always read through a run that
  was already checked for ownership; they are not exposed by any unscoped
  endpoint.
- Existing runs are migrated into projects by owner + repository on startup.
- The worker, TriggerWatcher and job queue intentionally operate across all
  users; they never serve user data. Isolation is enforced at the API/store
  boundary, not with PostgreSQL Row-Level Security.

## GitHub App ingress

- The public endpoint is `POST /api/github/webhook` in the webapp. It is the only
  unauthenticated app route, and every delivery must carry a valid
  `X-Hub-Signature-256` HMAC-SHA256 computed with
  `GITHUB_APP_WEBHOOK_SECRET`.
- Signature comparison uses `crypto.timingSafeEqual`. Missing or invalid
  signatures return `401`; the payload is never processed.
- After verification, the webapp forwards the raw event to the internal,
  bearer-protected `POST /api/github/events` on the factory. The browser never
  receives the service token.
- `X-GitHub-Delivery` is part of the job dedup key, making GitHub retries
  idempotent. Unsupported events return `202` with `enqueued: 0`.
- The webhook belongs to one GitHub App, not to each repository. The App is
  installed on selected repos/orgs and receives events only for those.
- Polling is off by default (`FACTORY_PR_POLLING=false`); enable it only as a
  local fallback when GitHub cannot reach the public webhook URL.

## Secrets

- `.env` contains the GitHub App private key, provider key, OpenCode password,
  `FACTORY_API_TOKEN`, `GITHUB_APP_WEBHOOK_SECRET`, `WEB_AUTH_SECRET` and any
  OAuth client secrets. It is gitignored and should stay at `600` permissions.
- Never commit `.env`. Never use `git add -f .env`.
- Tokens and private keys are not written to logs or `.git/config`.
- If a token or the App private key is shared through chat, logs, or screenshots,
  rotate it.
- The `opencode` container does not receive `DATABASE_URL`,
  `FACTORY_API_TOKEN`, `GITHUB_APP_ID`, the GitHub App private key,
  `GITHUB_APP_WEBHOOK_SECRET`, `WEB_AUTH_SECRET` or OAuth client secrets.
- The webapp receives `FACTORY_API_TOKEN`, database credentials for its own
  `users`/`user_identities` tables (`WEB_DATABASE_URL` can point to a
  least-privilege role), `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET` and OAuth
  client credentials.
- The `factory` container receives the GitHub App ID/private key and database
  credentials; it resolves an installation token per repository.
- Installation tokens are short-lived and scoped to the repositories selected
  during installation. The App cannot access other private repositories.

## Trust boundaries

`FACTORY_SETUP_CMD` and `FACTORY_TEST_CMD` are hints for the agents. Setup, build
and test commands run inside the OpenCode container, which has provider
credentials but no GitHub or database credentials. Only point the factory at
trusted repositories; a hostile repo could read the provider key.

For multi-user or public deployments, move setup/test execution to a runner
without secrets and add stronger sandboxing.

## Exposure

- The webapp is public at `https://web.factory.warias.app` and is the only
  public entry point; the GitHub webhook is served by the webapp at
  `/api/github/webhook`. The factory API, OpenCode runtime and PostgreSQL are
  ClusterIP-only in the Kubernetes deployment. The factory API still requires
  `Authorization: Bearer $FACTORY_API_TOKEN` on every route; use a
  `kubectl port-forward` for direct access.
- OpenCode port `4096` is not published.
- `NEXTAUTH_URL` and `WEB_PUBLIC_ORIGIN` point to the public HTTPS webapp;
  `WEB_COOKIE_SECURE=true` and `AUTH_TRUST_HOST=true` are required behind the
  reverse proxy.
- Use the GitHub App private key only in the factory container. Users install the
  App on selected repositories; the App cannot access the rest.
- Change the PostgreSQL password if this is not a local-only install.

## Known limits

- A single worker, one run at a time.
- Runs, projects, artifacts and events are isolated per user, but the database
  connection itself is shared by the factory; this is not PostgreSQL RLS.
- Session revocation requires rotating `WEB_AUTH_SECRET`; individual sessions
  are not stored server-side.
- The login rate limiter is in-memory and per webapp instance.
- GitHub/GitLab/Microsoft addresses are treated as verified because those
  providers expose managed addresses without an `email_verified` claim.
- Auto-merge requires a real human `APPROVED`; the GitHub App bot cannot approve
  its own PR.
- The GitHub App must be public to be installable by arbitrary users, and the
  person installing it needs admin access to the repository/org.
- Old worktrees and branches are not cleaned up automatically.

See [Architecture](../architecture.md) for runtime isolation details and
[Local testing](../local-testing/README.md) for the operational checks.
