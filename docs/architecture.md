# Arquitectura

## Principio rector

OpenCode es el **runtime de los agentes**, no el orquestador global. El
orquestador es un servicio propio que decide qué se hace, cuándo y por quién.
Así se puede cambiar el runtime sin rehacer el workflow.

```
┌──────────────┐  repo + issue  ┌──────────────────────────────────────┐
│   webapp     │───────────────►│              Orchestrator            │
│  (8080)      │                │  API · worker · state machine        │
└──────────────┘                └──────────────┬───────────────────────┘
                                               │
                     ┌─────────────────────────┼─────────────────────┐
                     ▼                         ▼                     ▼
              ┌────────────┐            ┌────────────┐        ┌────────────┐
              │ PostgreSQL │            │  OpenCode  │        │    Git     │
              │ runs       │            │  sessions  │        │ worktrees  │
              │ artifacts  │            │  agents    │        │ commits    │
              │ events     │            └────────────┘        └──────┬─────┘
              └────────────┘                                        │
                                                                    ▼
                                                            ┌────────────┐
                                                            │ GitHub Issue│
                                                            │ + PR        │
                                                            └────────────┘
```

El repo y el issue llegan en runtime desde la webapp o `POST /api/runs`. El
polling automático de un repo por defecto es opcional.

## Componentes

| Componente        | Responsabilidad                                                |
| ----------------- | -------------------------------------------------------------- |
| `src/index.ts`    | bootstrap, validación de configuración, shutdown                |
| `src/api.ts`      | API HTTP, incluido `POST /api/runs` (repo + issue URL)          |
| `web/`            | webapp para iniciar runs y ver su estado                        |
| `src/orchestrator.ts` | polling opcional, claim, worker único, sync de `Done`      |
| `src/workflow.ts` | pipeline del ticket y transiciones de estado                     |
| `src/backlog/github.ts` | conector de GitHub Issues (puerto `BacklogPort`)                 |
| `src/runtime/opencode.ts` | cliente de OpenCode Server (puerto `AgentRuntimePort`) |
| `src/scm/git.ts`  | clone por repo, `.factory.yml`, worktrees, commits, tests, push  |
| `src/scm/github.ts` | creación idempotente de Pull Requests en el repo del run      |
| `src/store/postgres.ts` | persistencia (puerto `RunStore`)                          |
| `src/domain/state.ts` | máquina de estados y validación de transiciones              |
| `src/domain/ticket.ts` | normalización de tickets y criterios de aceptación          |
| `src/squad/prompts.ts` | prompts por rol y cuerpo del PR                             |

Los puertos (`src/ports.ts`) permiten testear el workflow con dobles en memoria y
sustituir GitHub Issues, OpenCode o PostgreSQL sin tocar la lógica.

## Propiedad del workflow

Los agentes **no** cambian el estado. El orquestador:

1. valida que la transición es legal (`assertTransition`);
2. persiste el nuevo estado y un evento;
3. ejecuta la puerta correspondiente.

Un agente puede recomendar que una tarea está terminada, pero no puede declararla
terminada. El Reviewer solo aporta un veredicto; el orquestador decide si eso
implica `DELIVERY`, `REWORK` o `BLOCKED`.

## Máquina de estados

```
CLAIMED ──► PLANNING ──► PLANNED ──► BUILDING ──► QA ──► TESTING
                                                 ▲          │
                                                 │          ├── PASS ──► REVIEWING
                                                 │          └── FAIL ──► REWORK
                                                 │                        │
                                                 └────────────────────────┘
REVIEWING ── PASS ──► DELIVERY ──► HUMAN_REVIEW ──► DONE
    │                                  │
    └── FAIL ──► REWORK                └──► TRIAGING ──► HUMAN_REVIEW
                                              └───────► REWORK

estado activo ──► BLOCKED
```

Invariantes:

- No se puede saltar de `PLANNING` a `BUILDING` ni de `CLAIMED` a `DELIVERY`.
- `REWORK` solo puede volver a `BUILDING`.
- `HUMAN_REVIEW`, `DONE` y `BLOCKED` son terminales para la automatización;
  `HUMAN_REVIEW` puede reactivarse con una review `CHANGES_REQUESTED` (directo a
  `REWORK`) o con comentarios que pasan por `TRIAGING`.
- `BLOCKED` exige intervención humana; mover la tarjeta a `Ready` crea una nueva
  ejecución (el índice único solo cubre ejecuciones con `finished_at IS NULL`).

## Aislamiento con git worktrees

Cada ejecución tiene:

- worktree: `/data/worktrees/<ticket>-<run-id>/`
- rama: `factory/<ticket>-<run-id>`

El repositorio base se clona una vez en `/data/repos/<repo>/`. El worktree se crea
desde `origin/<base>` y se reutiliza si el proceso se reinicia. Los agentes nunca
comparten directorio.

El orquestador es el único que hace `git add`, `commit`, `push` y crea el PR. Los
prompts de los agentes prohíben explícitamente reescribir historia. El Builder
trabaja sobre el árbol de trabajo y el orquestador commitea al terminar.

## Artefactos

`artifacts` guarda texto y metadatos por paso. Son el contrato entre agentes:

- el plan alimenta al Builder, QA y Reviewer;
- el informe de build alimenta a QA;
- la salida de tests y el informe de QA alimentan al Reviewer;
- el veredicto del Reviewer decide la transición;
- el PR se construye a partir de todos ellos.

Los metadatos permiten decisiones deterministas: `tests.passed` y
`review.verdict` se guardan como JSONB, no se re-parsean del texto libre.

## Manejo de fallos

- **Error de agente o timeout**: se interrumpe la sesión y la ejecución pasa a
  `BLOCKED` con el motivo en PostgreSQL y en el issue.
- **Tests rojos**: feedback al Builder y nuevo ciclo, hasta `FACTORY_MAX_REWORK`.
- **Review FAIL**: mismo mecanismo, con los hallazgos como feedback.
- **Builder sin cambios**: se bloquea; evita PRs vacíos y bucles silenciosos.
- **Fallo de entrega**: push/PR falla → `BLOCKED`, nunca `HUMAN_REVIEW` falso.
- **Fallo de GitHub al actualizar el issue tras crear el PR**: se registra el warning y la ejecución se
  marca `HUMAN_REVIEW`; el trabajo ya está entregado.

`claimNext` selecciona la ejecución activa más antigua. En Fase 1 hay un solo
worker (una réplica). El flag `working` evita solapamientos dentro del proceso y
el índice único de PostgreSQL evita dos ejecuciones activas del mismo ticket. El
procesamiento concurrente del mismo run (leases) queda para la Fase 2.

## Seguridad

- El servidor OpenCode usa autenticación básica (`OPENCODE_SERVER_PASSWORD`) y no
  se publica fuera de la red de Compose.
- Los agentes tienen permisos por rol en su definición Markdown. La separación
  Planner/Reviewer (solo lectura) y Builder (escritura) es intencional.
- Las peticiones de permiso de OpenCode se responden automáticamente solo para
  sesiones creadas por la factoría; se registran en logs. Se puede desactivar con
  `FACTORY_AUTO_APPROVE_PERMISSIONS=false`.
- El token de GitHub se usa en memoria para git y la API; no se escribe en
  `.git/config`.
- El contenedor solo monta el volumen de datos y los agentes; no el home del host.
- El repo objetivo se resuelve por run desde la webapp/API. Usa
  `FACTORY_ALLOWED_REPOS` para limitarlo; sin allowlist, cualquier repo al que
  llegue el token puede ser clonado.
- `.factory.yml` se ejecuta desde el repo objetivo: trátalo como código de
  confianza y no apuntes la factoría a repos no confiables.

### Aislamiento del runtime OpenCode

El runtime del factory es deliberadamente distinto del OpenCode del desarrollador:

- `XDG_CONFIG_HOME=/config`, `XDG_DATA_HOME=/data/opencode/data`,
  `XDG_CACHE_HOME=/data/opencode/cache`, `XDG_STATE_HOME=/data/opencode/state`
  y `HOME=/data/opencode/home`, todos dentro del contenedor/volumen.
- `/config/opencode` solo contiene el `opencode.json` del factory y los agentes
  montados en modo lectura.
- No se monta `~/.config/opencode`, `~/.local/share/opencode` ni `~/.opencode`.
- El puerto 4096 no se publica; para desarrollo en el host, `compose.dev.yaml`
  publica `14096` (OpenCode) y `15432` (PostgreSQL) en `127.0.0.1`.
- `FACTORY_OPENCODE_URL` es obligatoria: no hay fallback silencioso a
  `127.0.0.1:4096`, que podría ser el runtime local del desarrollador.

Verificación: `docker compose exec opencode opencode debug paths` debe mostrar
todas las rutas bajo `/config` o `/data`.

## Evolución

La Fase 2 sustituye el worker único por una cola y añade builders paralelos. Los
puertos ya separan backlog, runtime, workspace y entrega, así que el cambio se
concentra en el orquestador y en el modelo de datos (tareas hijas, dependencias,
leases). Ver [`phases.md`](phases.md).
