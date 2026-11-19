# Factory phases

The target architecture is **model C**: a dynamic factory that creates
specialized squads based on ticket type and complexity. To get there without
building a distributed system all at once, the first implementation is **model
A** (one squad, one ticket at a time), validating the complete loop.

## Phase 1 — MVP: ticket → PR (implemented)

**Goal:** prove that a real GitHub issue can become a reviewable Pull Request,
with state, artifacts, and quality gates, running locally with Docker Compose.

Included:

- A dedicated orchestrator (Node.js + TypeScript), separate from the agent runtime.
- PostgreSQL for runs, artifacts, and events.
- GitHub Issues connector: webapp/API with repo + issue URL,
  claim, labels, comments, and closure.
- OpenCode Server as the runtime; one agent profile per role.
- Planner, Builder, QA, and Reviewer with distinct permissions.
- An isolated worktree per run and a `factory/<ticket>-<run>` branch.
- Target repo resolved at runtime; agents detect the toolchain and run build/tests.
- Deterministic test gate and review verdict.
- Review feedback: `CHANGES_REQUESTED` rework on the same PR, comment triage
  (`NO_ACTION`/`REWORK`), and opt-in auto-merge after a human `APPROVED` review.
- Bounded correction cycles (`FACTORY_MAX_REWORK`).
- Push and Pull Request in the issue's repo; `local` mode without push/PR.
- Inspection API, webapp, and `/health`.

Exit criteria:

- A run started from the webapp ends in `In Review` with an open PR.
- If tests fail, the Builder receives the failure and corrects it.
- If the Reviewer fails, there is rework or a block, never a false PASS.
- State and artifacts survive process restarts.

Not included: parallelism, multiple concurrent runs, dashboard, budgets,
historical metrics, leases/automatic retries, and advanced recovery of runs that
were interrupted mid-step.

## Phase 2 — Parallelism and decomposition

**Goal:** split a large ticket into tasks that can run in parallel without agents
stepping on each other.

Planned work:

- Structured plan parsing (JSON schema) and a dependency graph.
- Multiple builders per ticket, each with its own worktree and branch.
- Work queue (Redis/BullMQ or `SKIP LOCKED` on PostgreSQL).
- Concurrency limits per ticket, per repo, and globally.
- Integration strategy: integration branch, ordered merges, and conflict
  resolution by an integrator agent or by the orchestrator.
- Per-task context: only the ticket, relevant plan, documentation, and
  dependency results.
- QA Planner running in parallel with the builders.
- Horizontal workers: multiple containers consuming the same queue.

Exit criteria: two independent tickets advance at the same time without sharing
a directory or branch; a ticket with two dependent tasks is integrated and
delivered as a single PR.

## Phase 3 — Autonomous factory

**Goal:** operate continuously with human supervision only at critical points.

Planned work:

- GitHub webhooks for real-time events.
- Recovery of interrupted runs from the last completed step.
- Retries with backoff and automatic blocking after repeated failures.
- Per-ticket budget (tokens/cost) and automatic cutoff.
- Metrics: `Ready → PR` lead time, PR acceptance rate, rework cycles, cost per
  ticket, incidents introduced.
- Dashboard improvements (artifacts, logs, filters).
- Dynamic worker scaling.
- Advanced human-feedback routing across tickets and squads.
- Mandatory human approval policies for destructive migrations, security
  changes, and merges to protected branches.

Exit criteria: the factory processes tickets for days without intervention, with
visible metrics and budgets, and stops itself when it should.

## Phase 4 — Beyond software

**Goal:** turn the system into a production platform for any kind of asset, not
just code.

Planned work:

- Squads and workflows per work type: features, bugs, documentation, design,
  data, research, infrastructure.
- Agents and workflows registered as versioned configuration.
- A backlog agnostic to asset type: a ticket represents a unit of work.
- Heterogeneous artifacts: documents, images, analyses, infrastructure changes.
- Delivery policies per type (PR, document, report, deployment).

Exit criteria: adding a new squad does not require touching the orchestrator;
only profiles, permissions, and workflow are registered.

## Cross-cutting decisions

- **Ephemeral squads, persistent profiles.** Sessions are created per ticket and
  destroyed when they finish; profiles live in the repository.
- **The LLM does not own the workflow.** The orchestrator validates transitions;
  agents only produce artifacts and recommendations.
- **Artifacts as contracts.** Each step leaves a persisted document that the next
  agent consumes.
- **Worktree isolation.** Never run two agents in the same directory.
- **Deterministic gates.** Tests and delivery rules do not depend on the model's
  judgment.
- **Human approval at merge time.** Autonomy grows in phases, not all at once.
