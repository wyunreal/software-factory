# Software Factory

Factoría de software basada en agentes de IA. Convierte **GitHub Issues** en Pull
Requests ejecutando un squad de agentes sobre [OpenCode](https://opencode.ai) y
manteniendo el workflow bajo el control de un orquestador determinista.

El "Factory Manager" es ese orquestador, no un LLM: los modelos producen
artefactos y recomendaciones, pero no deciden el estado del ticket ni publican
cambios por su cuenta.

```
GitHub Issues (mismo repo)
      │
      ▼
Orchestrator ──► Planner ──► Builder ──► QA ──► Tests ──► Reviewer ──► PR
      │             │           │          │        │          │
      └─────────────┴───────────┴──────────┴──────────┴──────────┘
                  artefactos + estado en PostgreSQL
```

## Estado actual: Fase 1

Implementado y ejecutable con Docker Compose:

- Un único squad efímero, un ticket cada vez (modelo A).
- **Webapp** incluida para iniciar una ejecución pasando **repo + URL del issue**.
- Backlog en **GitHub Issues** del repo objetivo; el repo se resuelve en runtime.
- Polling automático opcional si configuras `GITHUB_REPOSITORY`/`FACTORY_REPO_URL`.
- Claim con etiquetas (`factory:in-progress`), comentarios y cierre del issue al
  mergear el PR.
- Agentes: **Planner**, **Builder**, **QA**, **Reviewer** sobre OpenCode.
- Aislamiento por **git worktree** y rama `factory/<ticket>-<run>`.
- Comandos de build/test por repo mediante `.factory.yml` (o fallback global).
- Puerta de calidad determinista y veredicto del reviewer.
- Rework acotado (`FACTORY_MAX_REWORK`).
- Entrega: push + **Pull Request** en el repo del issue (o modo `local` sin push/PR).
- Estado, artefactos y eventos persistidos en **PostgreSQL**.
- API HTTP y webapp para inspeccionar ejecuciones y forzar un tick.

Fuera de alcance en esta fase: paralelismo, cola distribuida, dashboard
avanzado, presupuestos y recuperación con leases. Ver
[`docs/phases.md`](docs/phases.md).

## Requisitos

- Docker + Docker Compose.
- Un repositorio en GitHub con Issues activados.
- Un **Personal Access Token** de GitHub con:
  - `Issues: read/write` (leer issues, crear etiquetas, comentar)
  - `Contents: read/write` (clonar y hacer push)
  - `Pull requests: read/write` (crear PRs)
  - Para un PAT clásico, el scope `repo` cubre todo.
- Credenciales de un proveedor de modelos. Para Ollama Cloud:
  `OLLAMA_API_KEY` (desde <https://ollama.com/settings/keys>).

La imagen base incluye Git, Bun, curl y ripgrep. Si el repo objetivo usa Python,
C++, Go o Node con un runtime propio, añade ese toolchain al `Dockerfile` o usa
comandos que funcionen con lo que hay. Los comandos salen de `.factory.yml`.

## Aislamiento: tu OpenCode local no se toca

El factory ejecuta **su propio servidor OpenCode dentro de Docker**. Docker Compose
lo levanta como el servicio `opencode`, en un contenedor hermano del orquestador;
la factory solo habla con él por HTTP. No reutiliza ni modifica el OpenCode de tu
máquina:

| Recurso | Dónde vive |
| --- | --- |
| Config del runtime | `/config/opencode` dentro del contenedor (solo lectura) |
| Agentes del factory | `./squads/software-development/agents` montado en `/config/opencode/agents` |
| Datos, sesiones y auth | Volumen Docker `software-factory_factory-data`, en `/data/opencode` |
| Home del proceso | `/data/opencode/home` |
| Puerto del servidor | `4096` interno; **no se publica al host** |
| Credenciales | `OPENCODE_SERVER_PASSWORD` + variables de proveedor del `.env` |

Concretamente, el compose **no** monta `~/.config/opencode`,
`~/.local/share/opencode` ni `~/.opencode`. Tampoco ejecuta el binario `opencode`
en el host: el orquestador solo habla HTTP con el contenedor.

Puedes comprobarlo con:

```bash
docker compose exec opencode sh -lc 'echo "config=$XDG_CONFIG_HOME"; opencode debug paths'
```

Debe mostrar `config /config/opencode`, `data /data/opencode/data/opencode`,
`cache` y `state` dentro de `/data`. Si alguna ruta apunta a `/root` o a un
directorio del host, algo se ha montado mal.

Para autenticar el runtime aislado:

```bash
docker compose exec opencode opencode auth login
```

Eso escribe en el volumen del factory, no en tu configuración local.

## Arranque rápido

```bash
cp .env.example .env
$EDITOR .env

docker compose up --build -d
docker compose ps
docker compose logs -f factory
```

`docker compose up` arranca **cuatro servicios**: `postgres`, `opencode`
(el runtime aislado de los agentes), `factory` (el orquestador) y `web`
(la webapp). No hace falta lanzar OpenCode aparte ni usar el OpenCode de tu máquina.

```
┌─────────────────────── red interna de Docker ───────────────────────┐
│  postgres  ◄──── factory ────HTTP───►  opencode (runtime aislado)   │
│                      ▲                                             │
│                      │ /api/*                                      │
│                    web ◄──── navegador                               │
└─────────────────────────────────────────────────────────────────────┘
        │                              │
 127.0.0.1:8080                  127.0.0.1:13000
 (webapp)                       (API del factory)
```

| Servicio | Qué es | Puerto en el host |
| --- | --- | --- |
| `postgres` | estado, artefactos y eventos | ninguno |
| `opencode` | runtime aislado de los agentes | ninguno |
| `factory` | orquestador y API | `127.0.0.1:3000` (`FACTORY_HOST_PORT`) |
| `web` | webapp para iniciar runs | `127.0.0.1:8080` (`WEB_HOST_PORT`) |

La factory espera a que `opencode` esté sano antes de arrancar. El puerto `4096`
del runtime es interno de la red de Compose; no se publica y no puede chocar con
tu OpenCode local.

Comprueba que todo está sano:

```bash
curl -s http://127.0.0.1:13000/health | jq
docker compose exec factory bun run scripts/opencode-check.ts
```

Abre la webapp en:

```text
http://127.0.0.1:8080
```

Si usas autenticación interactiva en lugar de variables de entorno:

```bash
docker compose exec opencode opencode auth login
```

## Iniciar un run desde la webapp

La webapp está en <http://127.0.0.1:8080>. Rellena:

- **Repositorio**: `https://github.com/owner/app`
- **URL del issue**: `https://github.com/owner/app/issues/123`
- **Rama base**: normalmente `main`
- Opcional: comandos de setup/test solo para esta ejecución

La factoría:

1. valida que el issue y el repo sean el mismo;
2. consulta el issue con `GITHUB_TOKEN`;
3. clona el repo, crea un worktree aislado y lee `.factory.yml`;
4. ejecuta Planner → Builder → QA → Tests → Reviewer;
5. comenta/etiqueta el issue y, si `FACTORY_DELIVERY_MODE=github`, abre el PR.

No hay que poner el repo en el issue: la webapp lo pasa explícitamente.

### `.factory.yml` en el repo objetivo

Los comandos de build/test se leen del propio repo, en la rama base:

```yaml
# .factory.yml
setup: bun install
test: bun test
```

Si el archivo no existe, se usan `FACTORY_SETUP_CMD` y `FACTORY_TEST_CMD` como
fallback. Si no hay comando de tests, la puerta determinista se omite.

Así el repo es dueño de su toolchain y no hay que hardcodear comandos por
proyecto en el motor.

### Token de GitHub

`GITHUB_TOKEN` es obligatorio. Permisos:

- **Issues**: read/write
- **Contents**: read/write
- **Pull requests**: read/write
- **Metadata**: read (automático)

**Sí, se puede limitar a un solo repo.** Para eso usa un **fine-grained PAT**:

```text
Repository access → Only select repositories → tu-repo
```

Un PAT clásico con scope `repo` da acceso a todos los repos a los que llega el
usuario; no se puede limitar por repositorio. Por eso, para producción/local con
un solo repo, usa fine-grained.

Si el repo está en una organización que restringe fine-grained PATs, el token
puede requerir aprobación del owner de la organización.

Si limitas el token a un repo, pon también:

```env
FACTORY_ALLOWED_REPOS=owner/tu-repo
```

Así la webapp rechaza cualquier otro repo antes de intentar clonarlo.

### Allowlist de repos

Si quieres limitar qué repos puede usar la webapp:

```env
FACTORY_ALLOWED_REPOS=owner/app,owner/other
```

Vacío = cualquier repo al que el token tenga acceso. En local es cómodo; en un
entorno compartido, define la allowlist.

### Polling opcional

La webapp es la vía principal. Si además quieres que la factoría descubra issues
sola, define un repo por defecto:

```env
GITHUB_REPOSITORY=owner/app
FACTORY_REPO_URL=https://github.com/owner/app.git
```

Con eso, los issues abiertos sin etiqueta de estado se procesan automáticamente.
Sin esas variables, solo se ejecutan los runs lanzados desde la webapp o la API.

### Modelo y proveedor

El modelo **no se configura en la webapp**. Se define de forma estática en `.env`
y se aplica a todas las sesiones cuando arrancas/recreas la factory.

Para Ollama Cloud:

```env
OLLAMA_API_KEY=tu_api_key_de_ollama
FACTORY_MODEL=ollama-cloud/deepseek-v4.1-flash:1017
```

- La API key se obtiene en <https://ollama.com/settings/keys>.
- OpenCode trae el provider `ollama-cloud` integrado, con base
  `https://ollama.com/v1`; no hace falta definir un provider a mano.
- La key se pasa al contenedor `opencode` por `env_file`; no se hornea en la imagen.
- Si falta la key o el modelo no existe, la factory falla al arrancar con
  `Model ollama-cloud/... is not available`.
- Para cambiar de modelo, edita `FACTORY_MODEL` y recrea:

```bash
docker compose up -d --force-recreate factory
```

Alternativas:

```env
# Free de OpenCode, sin API key
FACTORY_MODEL=opencode/hy4-flash-free

# Anthropic
FACTORY_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=...
```

### Auto-merge

La PR se crea solo si el Reviewer LLM da `PASS`. El auto-merge es una segunda
puerta, humana, sobre la PR ya creada:

```env
FACTORY_AUTO_MERGE=true
FACTORY_MERGE_METHOD=squash   # merge | squash | rebase
```

La factoría mergea cuando:

- hay al menos una review de GitHub en estado `APPROVED`;
- ningún reviewer tiene `CHANGES_REQUESTED` como última review decisiva;
- la PR está abierta, no es draft y GitHub la considera `mergeable` con
  `mergeable_state = clean`;
- se cumple lo que exija la branch protection del repo.

Si algo falla, la PR se queda en `HUMAN_REVIEW` y no se mergea. El merge usa el
SHA de cabeza actual para no mergear un commit distinto del revisado.

El auto-merge se comprueba en cada ciclo de polling. La review LLM del factory
no cuenta como review de GitHub; hace falta una aprobación humana real.

### Rework por review humana

Si un humano envía una review con `CHANGES_REQUESTED`, la factoría reabre el
desarrollo en el **mismo run, rama y PR**:

```env
FACTORY_REWORK_ON_CHANGES_REQUESTED=true
```

1. Detecta la review y sus comentarios inline.
2. Guarda el feedback como artefacto `feedback`.
3. Pasa el run a `REWORK` y vuelve a `BUILDING`.
4. El Builder recibe el feedback humano junto al plan y los artefactos previos.
5. QA, tests y Reviewer vuelven a ejecutarse.
6. Push a la misma rama: la PR se actualiza, no se crea otra.
7. La factoría responde a los comentarios inline y publica un comentario en la
   PR pidiendo re-review.
8. El auto-merge sigue esperando una review `APPROVED`.

Se deduplican reviews por ID y se respeta `FACTORY_MAX_REWORK`. Al agotarse, el
run pasa a `BLOCKED`.

### Triage de comentarios

Un comentario nuevo en la PR no reabre el desarrollo directamente: pasa por un
agente de triage que decide si hay trabajo real.

```env
FACTORY_TRIAGE_PR_COMMENTS=true
FACTORY_FEEDBACK_USERS=          # vacío = OWNER/MEMBER/COLLABORATOR
```

Flujo:

```text
comentario -> TRIAGING -> NO_ACTION -> HUMAN_REVIEW
                       -> REWORK    -> misma rama/PR
```

- `NO_ACTION` para “GOOD”, “thanks”, “LGTM” o comentarios ya resueltos.
- `REWORK` para bugs, cambios de comportamiento, tests que faltan o peticiones
  concretas.
- El triage puede procesar varios comentarios y decidir por cada uno.
- Los comentarios de la factory se ignoran por ID; los comentarios de usuarios
  no permitidos también.
- Un `CHANGES_REQUESTED` sigue yendo directo a `REWORK`, sin triage.

### El issue

Crea un issue abierto en el repo objetivo. No hace falta ponerle etiqueta:
un issue abierto sin etiqueta de estado y sin `factory:skip` es **Ready**.

Ejemplo de body:

```markdown
Arreglar el login para que rechace contraseñas vacías.

## Criterios de aceptación
- [ ] Un usuario válido puede iniciar sesión
- [ ] Las credenciales inválidas se rechazan con 401
- [ ] La sesión expira a las 24 horas
```

Los criterios se leen del body; también valen listas normales con `-`.

Etiquetas que usa la factoría:

| Etiqueta | Significado |
| --- | --- |
| `factory:in-progress` | la factoría lo ha reclamado |
| `factory:in-review` | hay PR / entrega lista para humano |
| `factory:blocked` | necesita intervención humana |
| `factory:skip` | ignorar este issue |

Los pull requests se ignoran automáticamente: la API de issues de GitHub los
devuelve mezclados, pero el adaptador los filtra.

## Probar en local

### 1. Tests rápidos, sin Docker ni OpenCode

```bash
bun install
bun test
bun run typecheck
```

Estos tests cubren la máquina de estados, el parser de issues, la configuración,
el adaptador de GitHub Issues (con API simulada) y el workflow completo con dobles
en memoria. No arrancan ningún agente ni tocan tu OpenCode.

### 2. Levantar el stack aislado

```bash
cp .env.example .env
$EDITOR .env
docker compose up --build -d
docker compose ps
docker compose logs -f opencode factory
```

El primer arranque construye la imagen (incluye Git, Bun y OpenCode) y arranca
el servidor OpenCode aislado. El repo objetivo se clona en `factory-data` cuando
lanzas el primer run. No hay ningún paso manual de “arrancar OpenCode”: lo hace
Compose.

### 3. Comprobar que el runtime es el aislado

```bash
docker compose exec opencode sh -lc 'opencode debug paths'
docker compose exec factory bun run scripts/opencode-check.ts
```

`debug paths` debe mostrar `config` en `/config/opencode` y `data`, `cache` y
`state` bajo `/data/opencode`. `opencode-check` imprime la URL que está usando;
si no defines `FACTORY_OPENCODE_URL`, falla en vez de asumir `127.0.0.1:4096`.

### 4. Validar GitHub (opcional si usas la webapp)

Si vas a usar polling automático (con `GITHUB_REPOSITORY`/`FACTORY_REPO_URL`):

```bash
docker compose exec factory bun run scripts/github-check.ts
```

Debe validar el repo, crear las etiquetas que falten y listar los issues que
serían reclamados. En modo webapp puedes saltarte este paso; la validación se
hace al iniciar cada run.

### 5. Prueba end-to-end sin publicar PR

Usa `FACTORY_DELIVERY_MODE=local` (ya está así en `.env`) para que no haga push
ni cree PR, pero sí etiquete y comente el issue.

1. Abre <http://127.0.0.1:8080>.
2. Rellena:
   - Repositorio: `https://github.com/owner/app`
   - Issue: `https://github.com/owner/app/issues/123`
   - Rama base: `main`
3. Pulsa **Iniciar desarrollo**.
4. Observa el progreso en la propia webapp o en:

```bash
docker compose logs -f factory
curl -s http://127.0.0.1:13000/api/runs | jq
```

5. Inspecciona la ejecución y sus artefactos:

```bash
RUN_ID=$(curl -s http://127.0.0.1:13000/api/runs | jq -r '.data[0].id')
curl -s "http://127.0.0.1:13000/api/runs/$RUN_ID" \
  | jq '{state: .data.state, repoUrl: .data.repoUrl, worktree: .data.worktree, artifacts: [.data.artifacts[].name]}'
```

6. Inspecciona el trabajo generado:

```bash
docker compose exec factory sh -lc \
  'cd /data/worktrees/* && git log --oneline --decorate && git diff main...HEAD --stat'
```

7. El issue debe quedar con `factory:in-review` y un comentario de la factoría.

### 6. Prueba end-to-end con Pull Request

Cambia a `FACTORY_DELIVERY_MODE=github`:

```bash
docker compose up -d --force-recreate factory
```

Lanza un run nuevo desde la webapp con otro issue. Al terminar debe aparecer un
PR **en el repo del issue**, con:

- el plan, el informe del builder, QA, tests y review en el cuerpo;
- la referencia `Closes #<issue>`, de modo que el merge cierre el issue;
- la rama `factory/<ticket>-<run>`.

El token necesita `Contents: write` y `Pull requests: write`.

Cuando el PR se mergea y GitHub cierra el issue, la factoría marca la ejecución
como `DONE` en el siguiente poll.

### 7. Desarrollo del orquestador en el host

Este apartado es **solo** para modificar el código del orquestador ejecutándolo
con Bun en tu máquina. En el flujo normal no lo necesitas: `docker compose up`
ya levanta OpenCode y la factory.

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:factory@127.0.0.1:15432/factory \
bun run src/index.ts
```

`compose.dev.yaml` monta `.factory-dev` en el contenedor en la misma ruta
absoluta, de modo que los worktrees que crea el proceso del host son visibles
para los agentes. No arranques el servicio `factory` de Compose a la vez que el
proceso del host: dos workers compartirían la misma base de datos.

### 8. Limpieza

```bash
docker compose down          # conserva la base de datos y los worktrees
docker compose down -v       # borra todo el estado del factory
```

`down -v` elimina el volumen `factory-data` y con él las credenciales, sesiones,
clones y worktrees del runtime aislado. No afecta a tu OpenCode local.

### Problemas frecuentes

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `OpenCode ... 401` | password distinta entre servicios | usa el mismo `.env`; reinicia con `docker compose up -d --force-recreate` |
| `GitHub ... 401` | token inválido | regenera el PAT |
| `GitHub ... 403` | token sin permisos | concede Issues, Contents y Pull requests |
| `GitHub ... 404` | repo mal escrito o sin acceso | revisa la URL del repo/issue |
| `Repository mismatch` | repo y issue son de repos distintos | usa el repo donde vive el issue |
| `Issue #N is closed` | el issue ya está cerrado | usa un issue abierto |
| La webapp devuelve 502 | la factory no está arriba | `docker compose ps` y `docker compose logs factory` |
| El issue no se procesa en polling | etiqueta de estado, `factory:skip` o repo por defecto no configurado | revisa etiquetas y `/api/runs` |
| `Setup command failed` | dependencias o toolchain ausente | amplía el `Dockerfile` o corrige `FACTORY_SETUP_CMD` |
| Tests rojos siempre | faltan dependencias o el comando no existe en la imagen | prueba `docker compose exec factory sh -lc '<cmd>'` |
| `Builder produced no changes` | el agente no modificó nada | revisa el artefacto `build` |
| `Bind for 0.0.0.0:3000 failed` | otro proceso usa el puerto 3000 | define `FACTORY_HOST_PORT=13000` |
| `Bind for 0.0.0.0:8080 failed` | otro proceso usa el puerto 8080 | define `WEB_HOST_PORT=8081` |
| `Location not found` | ruta del worktree no visible desde OpenCode | no montes rutas del host; usa el volumen `/data` |

## Cómo funciona una ejecución

1. La webapp o `POST /api/runs` recibe **repo + URL del issue** y crea una
   ejecución (`CLAIMED`). Opcionalmente, el poller puede descubrir issues si
   configuras un repo por defecto.
2. La factoría valida que issue y repo coincidan, consulta el issue y aplica
   `factory:in-progress` + comentario.
3. Clona el repo objetivo y crea un worktree aislado en el volumen
   `factory-data`.
4. Lee `.factory.yml` de la rama base para resolver setup/test.
5. **Planner** explora el repo y produce `plan`.
6. **Builder** implementa y deja los cambios sin commitear. El orquestador hace
   el commit; a los agentes se les prohíbe reescribir historia por prompt y por
   permisos.
7. **QA** añade/repasa tests (solo puede editar ficheros de test).
8. El orquestador ejecuta el comando de tests resuelto. Si falla, vuelve a
   `BUILDING` con el output como feedback, hasta `FACTORY_MAX_REWORK` veces.
9. **Reviewer** revisa el diff y responde `VERDICT: PASS` o `VERDICT: FAIL`.
   Un FAIL también consume un ciclo de rework.
10. En `DELIVERY` se hace push de la rama y se crea el PR en el repo del issue,
    con `Closes #<issue>` en el cuerpo.
11. El issue se etiqueta con `factory:in-review` y la ejecución queda en
    `HUMAN_REVIEW`. Cuando el PR se mergea y el issue se cierra, el poller pasa
    la ejecución a `DONE`.

Diagrama de estados:

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

Cualquier estado activo puede terminar en BLOCKED.
```

## Artefactos

Cada paso deja un artefacto persistido en PostgreSQL y visible por API:

| Artefacto  | Productor        | Contenido                                      |
| ---------- | ---------------- | ---------------------------------------------- |
| `plan`     | Planner          | análisis, criterios, tareas, riesgos           |
| `build`    | Builder          | resumen, cambios, pruebas ejecutadas           |
| `qa`       | QA               | plan de pruebas, tests añadidos, resultado     |
| `tests`    | Orquestador      | salida literal de `FACTORY_TEST_CMD`           |
| `review`   | Reviewer         | veredicto y hallazgos                          |
| `delivery` | Orquestador      | URL del PR o ruta de la rama en modo local     |

Los agentes se comunican mediante estos artefactos, no solo por conversación.

## API

La API escucha en `127.0.0.1:${FACTORY_HOST_PORT}` (en el `.env` de ejemplo,
`13000` porque el 3000 puede estar ocupado). Si defines `FACTORY_API_TOKEN`,
envía `Authorization: Bearer <token>` en las rutas `/api/*`.

| Método | Ruta              | Descripción                                  |
| ------ | ----------------- | -------------------------------------------- |
| GET    | `/health`         | estado de PostgreSQL, OpenCode y orquestador |
| GET    | `/api/status`     | estadísticas y flags del orquestador         |
| GET    | `/api/runs`       | últimas ejecuciones (`?limit=`)              |
| GET    | `/api/runs/:id`   | ejecución + artefactos + eventos             |
| POST   | `/api/runs`       | inicia un run con `repoUrl` + `issueUrl`      |
| POST   | `/api/tick`       | fuerza un ciclo de polling y trabajo         |

Ejemplo:

```bash
curl -s -X POST http://127.0.0.1:13000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repoUrl": "https://github.com/owner/app",
    "issueUrl": "https://github.com/owner/app/issues/123",
    "baseBranch": "main"
  }' | jq
```

Opcionalmente acepta `setupCommand` y `testCommand` para esa ejecución; si no,
se usan `.factory.yml`, `FACTORY_SETUP_CMD` y `FACTORY_TEST_CMD`.

## Agentes

Los perfiles viven en `squads/software-development/agents/` y se montan en el
contenedor de OpenCode como agentes globales. No se escriben dentro del repo
objetivo.

| Agente             | Permisos                                                    |
| ------------------ | ----------------------------------------------------------- |
| `factory-planner`  | solo lectura (`read`, `glob`, `grep`); sin shell ni edición |
| `factory-builder`  | lectura, edición y shell; sin subagentes                     |
| `factory-qa`       | shell + edición limitada a ficheros de test                  |
| `factory-reviewer` | solo lectura + `git` de solo lectura; sin edición general    |
| `factory-feedback-triage` | solo lectura + `git`; decide `NO_ACTION` o `REWORK`    |

El orquestador crea una sesión de OpenCode por paso. Los agentes son perfiles
persistentes; las sesiones y los worktrees son efímeros.

## Configuración

Todas las variables están documentadas en [`.env.example`](.env.example).
Las más importantes:

| Variable                 | Por defecto        | Descripción                                  |
| ------------------------ | ------------------ | -------------------------------------------- |
| `GITHUB_TOKEN`           | — (obligatoria)    | PAT con Issues, Contents y Pull requests     |
| `GITHUB_REPOSITORY`      | vacío              | repo para polling automático (opcional)      |
| `FACTORY_REPO_URL`       | vacío              | URL del repo de polling (opcional)           |
| `FACTORY_ALLOWED_REPOS`  | vacío              | allowlist `owner/repo` separada por comas    |
| `FACTORY_BASE_BRANCH`    | `main`             | rama base por defecto                        |
| `FACTORY_TEST_CMD`       | vacío              | fallback si el repo no tiene `.factory.yml`  |
| `FACTORY_SETUP_CMD`      | vacío              | fallback de instalación                      |
| `FACTORY_MAX_REWORK`     | `3`                | ciclos máximos de corrección                 |
| `FACTORY_DELIVERY_MODE`  | `github`           | `github` o `local`                           |
| `FACTORY_AUTO_MERGE`     | `false`            | mergea PRs con review APPROVED                |
| `FACTORY_MERGE_METHOD`   | `squash`           | `merge`, `squash` o `rebase`                 |
| `FACTORY_REWORK_ON_CHANGES_REQUESTED` | `true` | reabre el desarrollo con CHANGES_REQUESTED |
| `FACTORY_TRIAGE_PR_COMMENTS` | `true`         | evalúa comentarios de la PR antes de rework  |
| `FACTORY_FEEDBACK_USERS` | vacío              | allowlist de logins que pueden dar feedback  |
| `FACTORY_LABEL_IN_PROGRESS` | `factory:in-progress` | etiqueta de claim                       |
| `FACTORY_LABEL_IN_REVIEW`| `factory:in-review`| etiqueta de entrega                          |
| `FACTORY_LABEL_BLOCKED`  | `factory:blocked`  | etiqueta de bloqueo                          |
| `FACTORY_LABEL_READY`    | vacío              | opt-in: solo issues con esta etiqueta        |
| `FACTORY_SKIP_LABELS`    | `factory:skip`     | etiquetas que se ignoran                     |
| `FACTORY_MODEL`          | modelo por defecto | `provider/model[#variant]` para todos los agentes |
| `OLLAMA_API_KEY`         | vacío              | API key de Ollama Cloud (provider `ollama-cloud`) |
| `FACTORY_OPENCODE_URL`   | — (obligatoria)    | URL del runtime aislado; Compose usa `http://opencode:4096` |
| `FACTORY_HOST_PORT`      | `3000`             | puerto del host para la API                  |
| `WEB_HOST_PORT`          | `8080`             | puerto del host para la webapp               |
| `POSTGRES_USER`          | `factory`          | usuario de PostgreSQL                        |
| `POSTGRES_PASSWORD`      | — (obligatoria)    | password de PostgreSQL, leído del `.env`     |
| `POSTGRES_DB`            | `factory`          | base de datos                                |
| `DATABASE_URL`           | — (obligatoria)    | URL completa; debe usar el mismo password    |
| `FACTORY_AUTO_APPROVE_PERMISSIONS` | `true`    | responde permisos "ask" de OpenCode          |

## Mapa del proyecto

| Ruta | Contenido |
| --- | --- |
| `src/index.ts` | arranque, validación y shutdown |
| `src/orchestrator.ts` | polling opcional, claim, worker y sync de cerrados |
| `src/workflow.ts` | pipeline y transiciones de estado |
| `src/api.ts` | API HTTP, incluido `POST /api/runs` |
| `web/` | webapp para iniciar runs con repo + issue URL |
| `src/domain/` | tipos, máquina de estados y parser de issues |
| `src/backlog/github.ts` | conector de GitHub Issues |
| `src/runtime/opencode.ts` | cliente HTTP de OpenCode (sesiones, permisos, espera) |
| `src/scm/git.ts` | clone, worktrees, commits, tests y push |
| `src/scm/github.ts` | creación idempotente de Pull Requests |
| `src/store/` | PostgreSQL y store en memoria para tests |
| `src/squad/prompts.ts` | prompts de cada rol y cuerpo del PR |
| `squads/software-development/agents/` | perfiles y permisos de los agentes |
| `tests/` | tests unitarios y de workflow |
| `docs/` | arquitectura y fases |
| `compose.yaml` | stack aislado |
| `compose.dev.yaml` | puertos altos para desarrollo en el host |

## Desarrollo

La aplicación corre con Bun y no tiene dependencias de runtime. El flujo
recomendado para iterar está en [Probar en local](#probar-en-local):

```bash
bun install
bun test
bun run typecheck
```

Para ejecutar el orquestador en el host contra el runtime aislado:

```bash
mkdir -p .factory-dev
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres opencode

FACTORY_DATA_DIR="$PWD/.factory-dev" \
FACTORY_OPENCODE_URL=http://127.0.0.1:14096 \
DATABASE_URL=postgres://factory:factory@127.0.0.1:15432/factory \
bun run src/index.ts
```

`FACTORY_OPENCODE_URL` es obligatoria a propósito: el código nunca asume
`127.0.0.1:4096`, para que un despiste no acabe usando tu OpenCode local.

### Añadir un agente

1. Crea `squads/software-development/agents/factory-<rol>.md`.
2. Declara `description`, `mode`, `steps` y `permissions` en el frontmatter.
3. Añade el ID a la lista de verificación de `src/index.ts`.
4. Añade su prompt y su paso en `src/workflow.ts`, con transiciones válidas en
   `src/domain/state.ts`.
5. Añade tests del nuevo paso en `tests/workflow.test.ts`.

### Añadir un conector de backlog

Implementa `BacklogPort` en `src/ports.ts` y construye el adaptador en
`src/index.ts`. El workflow no conoce GitHub: solo usa el puerto. Para Jira,
Linear o Vikunja, replica el patrón de `src/backlog/github.ts`.

## Skill del proyecto

El conocimiento operativo del proyecto está en
[`.opencode/skills/software-factory/SKILL.md`](.opencode/skills/software-factory/SKILL.md).
Se carga automáticamente en futuras sesiones de OpenCode abiertas en este
repositorio y contiene:

- arquitectura e invariantes que no se deben romper;
- comandos de test y de arranque;
- reglas de aislamiento del runtime;
- errores conocidos de la API de OpenCode;
- estado de las fases y siguientes pasos.

Es una skill **project-local**: no modifica la configuración global de tu
OpenCode ni la del runtime del factory. Si cambias la arquitectura, actualiza la
skill en el mismo cambio que el código.

## Seguridad y límites

- El contenedor de OpenCode tiene acceso al volumen compartido `/data`, no al
  resto del host.
- El Reviewer no puede editar; el Planner tampoco. La separación es deliberada.
- El orquestador es quien decide transiciones, commits, push y PR. Un agente no
  puede declarar un ticket terminado.
- Los tokens no se registran en logs ni se guardan en la configuración de git.
- `.env` está ignorado por git y debe quedarse en permisos `600`; no lo commitees.
  Si un token se comparte por chat, logs o capturas, rótalo.
- El contenedor `opencode` no recibe `GITHUB_TOKEN` ni `DATABASE_URL`; la webapp
  solo recibe `FACTORY_API_TOKEN`. La factory sí necesita GitHub/DB.
- `FACTORY_SETUP_CMD`, `FACTORY_TEST_CMD` y los comandos de `.factory.yml` se
  ejecutan en el contenedor de la factory y heredan su entorno. Ejecuta solo
  repositorios y configuraciones de confianza.
- El PR queda para revisión humana por defecto. Con `FACTORY_AUTO_MERGE=true` solo
  se mergea tras una review `APPROVED` y un estado `clean`.
- El token de GitHub tiene acceso de escritura al repo: trátalo como un secreto.
- La webapp/API acepta repos en runtime. Si la expones fuera de tu máquina,
  define `FACTORY_ALLOWED_REPOS` y `FACTORY_API_TOKEN`.
- `.factory.yml` se lee del repo objetivo; quien controla ese repo controla los
  comandos que se ejecutan. No uses repos no confiables.
- La contraseña `factory` de PostgreSQL en Compose es un valor local de
  desarrollo; cámbiala si no es una instalación estrictamente local.
- Esta fase está pensada para ejecución local. No expongas la API a Internet ni
  ejecutes agentes sobre repositorios sin revisar sus permisos.
