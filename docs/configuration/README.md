# Configuration

All variables are documented in [`.env.example`](../../.env.example). This guide
explains the behavior behind the most important ones.

## Model and provider

The model is static for the stack; it is not configured in the webapp. Edit
`.env` and recreate the factory.

Ollama Cloud:

```env
OLLAMA_API_KEY=your_ollama_api_key
FACTORY_MODEL=ollama-cloud/deepseek-v4.1-flash:1017
```

- Get the key at <https://ollama.com/settings/keys>.
- OpenCode includes the `ollama-cloud` provider (`https://ollama.com/v1`).
- The key reaches the `opencode` container through Compose environment variables;
  it is not baked into the image.
- If the key or model is missing, startup fails with
  `Model ollama-cloud/... is not available`.

Recreate after changing it:

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

## Auto-merge

The PR is created only after the LLM Reviewer returns `PASS`. Auto-merge is a
second, human gate on the existing PR.

```env
FACTORY_AUTO_MERGE=true
FACTORY_MERGE_METHOD=squash   # merge | squash | rebase
```

The factory merges only when:

- at least one GitHub review is `APPROVED`;
- no reviewer's latest decisive review is `CHANGES_REQUESTED`;
- the PR is open, not draft, `mergeable`, with `mergeable_state = clean`;
- branch protection requirements are met.

Otherwise the PR stays in `HUMAN_REVIEW`. The merge uses the current head SHA.

If the factory and the human share a GitHub user, GitHub will not allow that
user to approve its own PR. Use a bot account, a GitHub App, or a second
reviewer.

## Rework from review

A human `CHANGES_REQUESTED` review reopens the **same run, branch, and PR**:

```env
FACTORY_REWORK_ON_CHANGES_REQUESTED=true
```

1. Detect the review and its inline comments.
2. Store a `feedback` artifact.
3. Move to `REWORK` and back to `BUILDING`.
4. Builder receives the feedback plus the plan and prior artifacts.
5. QA, tests, and Reviewer run again.
6. Push to the same branch; the PR is updated, not recreated.
7. Reply to inline comments and ask for re-review.
8. Auto-merge waits for `APPROVED`.

Reviews are deduplicated by ID and bounded by `FACTORY_MAX_REWORK`.

## Comment triage

A new PR comment triggers an evaluation, not an automatic rework:

```env
FACTORY_TRIAGE_PR_COMMENTS=true
FACTORY_FEEDBACK_USERS=          # empty = OWNER/MEMBER/COLLABORATOR
```

```text
comment -> TRIAGING -> NO_ACTION -> HUMAN_REVIEW
                    -> REWORK    -> same branch/PR
```

- `NO_ACTION`: “GOOD”, “thanks”, “LGTM”, or already resolved.
- `REWORK`: bugs, behavior changes, missing tests, concrete requests.
- Triage decides per comment and can handle several at once.
- Factory comments are ignored by ID; disallowed authors are ignored.
- `CHANGES_REQUESTED` skips triage and goes straight to `REWORK`.

## Issue format

Create an open issue in the target repo. No label is required.

```markdown
Fix login so it rejects empty passwords.

## Acceptance criteria
- [ ] A valid user can sign in
- [ ] Invalid credentials are rejected with 401
- [ ] The session expires after 24 hours
```

Criteria are read from the body; plain `-` lists also work.

| Label | Meaning |
| --- | --- |
| `factory:in-progress` | claimed by the factory |
| `factory:in-review` | PR / delivery ready for a human |
| `factory:blocked` | needs human intervention |
| `factory:skip` | ignore this issue |

Pull requests are rejected as tickets.

## Webapp authentication

The webapp is closed by default: every page except `/login` and `/register`
requires a signed-in session, and every `/api/*` request is rejected without
one. Users live in the `users` table; OAuth links live in `user_identities`.

Stable NextAuth v4 supports email/password (Credentials) plus OAuth2. Enable
any subset with the provider credentials; the buttons appear automatically.
Register the callback URL in each provider:
`${NEXTAUTH_URL}/api/auth/callback/<provider>`.

```env
FACTORY_API_TOKEN=<openssl rand -hex 32>   # required, also protects the API
WEB_AUTH_SECRET=<openssl rand -hex 32>     # required, encrypts session JWTs
NEXTAUTH_URL=http://localhost:8080         # public origin for OAuth callbacks
AUTH_TRUST_HOST=true                       # behind a reverse proxy
WEB_REGISTRATION_CODE=                     # optional code for password sign-up
WEB_COOKIE_SECURE=false                    # true behind HTTPS
WEB_SESSION_TTL_HOURS=168                  # 1-720
WEB_DATABASE_URL=                          # optional least-privilege DB role

AUTH_GOOGLE_ID=                            # and _SECRET
AUTH_GITHUB_ID=                            # and _SECRET
AUTH_APPLE_ID=                             # and _SECRET (client secret JWT)
AUTH_AZURE_AD_ID=                          # and _SECRET, _TENANT_ID
AUTH_GITLAB_ID=                            # and _SECRET
```

For local OAuth use <http://localhost:8080> (not `127.0.0.1`) and register that
exact callback. Apple requires a public HTTPS return URL. The factory API
requires `Authorization: Bearer $FACTORY_API_TOKEN` on every route, including
`/health`.

OAuth sign-in links an identity to an existing account only when the provider
confirms the email. Password sign-up still works at `/register`; use
`WEB_REGISTRATION_CODE` to gate it.

## Environment reference

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | — (required) | PAT with Issues, Contents, Pull requests |
| `FACTORY_TEST_CMD` | empty | test command hint for the Builder/Verifier |
| `FACTORY_SETUP_CMD` | empty | setup command hint for the Builder |
| `FACTORY_MAX_REWORK` | `3` | maximum correction cycles |
| `FACTORY_POLL_INTERVAL_MS` | `15000` | PR activity scan interval |
| `FACTORY_WORKER_INTERVAL_MS` | `5000` | job worker polling interval |
| `FACTORY_DELIVERY_MODE` | `github` | `github` or `local` |
| `FACTORY_AUTO_MERGE` | `false` | merge after APPROVED |
| `FACTORY_MERGE_METHOD` | `squash` | `merge`, `squash`, `rebase` |
| `FACTORY_REWORK_ON_CHANGES_REQUESTED` | `true` | reopen on CHANGES_REQUESTED |
| `FACTORY_TRIAGE_PR_COMMENTS` | `true` | triage PR comments |
| `FACTORY_FEEDBACK_USERS` | empty | allowed feedback logins |
| `FACTORY_LABEL_IN_PROGRESS` | `factory:in-progress` | claim label |
| `FACTORY_LABEL_IN_REVIEW` | `factory:in-review` | review label |
| `FACTORY_LABEL_BLOCKED` | `factory:blocked` | blocked label |
| `FACTORY_LABEL_READY` | empty | optional ready label |
| `FACTORY_SKIP_LABELS` | `factory:skip` | ignored labels |
| `FACTORY_MODEL` | default model | `provider/model[#variant]` |
| `OLLAMA_API_KEY` | empty | Ollama Cloud key |
| `FACTORY_OPENCODE_URL` | — (required) | isolated runtime URL |
| `FACTORY_HOST_PORT` | `3000` | API host port |
| `FACTORY_API_TOKEN` | — (required) | bearer token for every factory API route |
| `WEB_HOST_PORT` | `8080` | webapp host port |
| `WEB_AUTH_SECRET` | — (required) | encrypts NextAuth session JWTs (32+ chars) |
| `WEB_REGISTRATION_CODE` | empty | required invite code when set |
| `WEB_COOKIE_SECURE` | `false` | mark session cookies `Secure` (HTTPS) |
| `WEB_SESSION_TTL_HOURS` | `168` | webapp session lifetime |
| `WEB_PUBLIC_ORIGIN` | empty | public origin used to derive cookie security |
| `WEB_DATABASE_URL` | empty | DB URL for `users` (falls back to `DATABASE_URL`) |
| `NEXTAUTH_URL` | `http://localhost:8080` | public origin used for OAuth callbacks |
| `NEXTAUTH_SECRET` | `WEB_AUTH_SECRET` | optional alias for the NextAuth secret |
| `AUTH_TRUST_HOST` | `true` | trust the forwarded host behind a proxy |
| `AUTH_GOOGLE_ID` / `_SECRET` | empty | Google OAuth client |
| `AUTH_GITHUB_ID` / `_SECRET` | empty | GitHub OAuth app |
| `AUTH_APPLE_ID` / `_SECRET` | empty | Apple Services ID and client secret JWT |
| `AUTH_AZURE_AD_ID` / `_SECRET` | empty | Microsoft Entra ID app; provider id `azure-ad` |
| `AUTH_AZURE_AD_TENANT_ID` | `common` | Entra ID tenant |
| `AUTH_GITLAB_ID` / `_SECRET` | empty | GitLab.com OAuth app |
| `POSTGRES_USER` | `factory` | PostgreSQL user |
| `POSTGRES_PASSWORD` | — (required) | PostgreSQL password from `.env` |
| `POSTGRES_DB` | `factory` | database |
| `DATABASE_URL` | — (required) | full DB URL |
| `FACTORY_AUTO_APPROVE_PERMISSIONS` | `true` | answer OpenCode "ask" permissions |

The database password and `DATABASE_URL` must match. Changing the password
requires updating both and either resetting the volume or altering the Postgres
role.

## Next

- [Local testing](../local-testing/README.md)
- [Operations](../operations/README.md)
- [Security](../security/README.md)
