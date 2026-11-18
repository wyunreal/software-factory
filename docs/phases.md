# Fases de la factoría

La arquitectura objetivo es el **modelo C**: una factoría dinámica que crea
squads especializados según el tipo y complejidad del ticket. Para llegar ahí sin
construir de golpe un sistema distribuido, se implementa primero el **modelo A**
(un squad, un ticket a la vez) y se valida el circuito completo.

## Fase 1 — MVP: ticket → PR (implementada)

**Objetivo:** demostrar que un issue real de GitHub se convierte en un Pull
Request revisable, con estado, artefactos y puertas de calidad, ejecutándose en
local con Docker Compose.

Incluido:

- Orquestador propio (Bun + TypeScript) separado del runtime de agentes.
- PostgreSQL para ejecuciones, artefactos y eventos.
- Conector de GitHub Issues: webapp/API con repo + issue URL, polling opcional,
  claim, etiquetas, comentarios y cierre.
- OpenCode Server como runtime; un perfil de agente por rol.
- Planner, Builder, QA y Reviewer con permisos distintos.
- Worktree aislado por ejecución y rama `factory/<ticket>-<run>`.
- Repo objetivo resuelto en runtime, con `.factory.yml` para setup/test.
- Puerta de tests determinista y veredicto de review.
- Reintentos de corrección acotados (`FACTORY_MAX_REWORK`).
- Push y Pull Request en el repo del issue; modo `local` sin push/PR.
- API de inspección, webapp y `/health`.

Criterio de salida:

- Un run iniciado desde la webapp termina en `In Review` con un PR abierto.
- Si los tests fallan, el Builder recibe el fallo y corrige.
- Si el Reviewer falla, hay rework o bloqueo, nunca un falso PASS.
- El estado y los artefactos sobreviven a reinicios del proceso.

No incluido: paralelismo, varios runs concurrentes, dashboard,
presupuestos, métricas históricas, leases/reintentos automáticos y recuperación
avanzada de ejecuciones a medio paso.

## Fase 2 — Paralelismo y descomposición

**Objetivo:** que un ticket grande se divida en tareas ejecutables en paralelo
sin que los agentes se pisen.

Trabajo previsto:

- Parseo estructurado del plan (JSON schema) y grafo de dependencias.
- Varios builders por ticket, cada uno con su worktree y su rama.
- Cola de trabajo (Redis/BullMQ o `SKIP LOCKED` sobre PostgreSQL).
- Límites de concurrencia por ticket, por repo y globales.
- Estrategia de integración: rama de integración, merges ordenados y resolución
  de conflictos por un agente integrador o por el orquestador.
- Contexto por tarea: solo ticket, plan relevante, documentación y resultados de
  dependencias.
- QA Planner en paralelo con los builders.
- Workers horizontales: varios contenedores consumiendo la misma cola.

Criterio de salida: dos tickets independientes avanzan a la vez sin compartir
directorio ni rama; un ticket con dos tareas dependientes se integra y entrega un
único PR.

## Fase 3 — Factoría autónoma

**Objetivo:** operar de forma continua con supervisión humana solo en los puntos
críticos.

Trabajo previsto:

- Webhooks de GitHub además del polling.
- Recuperación de ejecuciones interrumpidas desde el último paso completado.
- Reintentos con backoff y bloqueo automático ante fallos repetidos.
- Presupuesto por ticket (tokens/coste) y corte automático.
- Métricas: lead time `Ready → PR`, tasa de PR aceptados, ciclos de rework,
  coste por ticket, incidencias introducidas.
- Dashboard (Next.js) y trazas OpenTelemetry.
- Escalado dinámico de workers.
- Bucle de feedback del PR: comentarios de revisión humana convertidos en nuevas
  tareas para el squad.
- Políticas de aprobación humana obligatoria para migraciones destructivas,
  cambios de seguridad y merge a ramas protegidas.

Criterio de salida: la factoría procesa tickets durante días sin intervención,
con métricas y presupuestos visibles, y se detiene sola cuando debe.

## Fase 4 — Más allá del software

**Objetivo:** convertir el sistema en una plataforma de producción de cualquier
activo, no solo código.

Trabajo previsto:

- Squads y workflows por tipo de trabajo: features, bugs, documentación, diseño,
  datos, investigación, infraestructura.
- Registro de agentes y workflows como configuración versionada.
- Backlog agnóstico al tipo de activo: un ticket representa una unidad de trabajo.
- Artefactos heterogéneos: documentos, imágenes, análisis, cambios de infra.
- Políticas de entrega por tipo (PR, documento, informe, despliegue).

Criterio de salida: añadir un squad nuevo no requiere tocar el orquestador; solo
se registran perfiles, permisos y workflow.

## Decisiones transversales

- **Squads efímeros, perfiles persistentes.** Se instancian sesiones por ticket y
  se destruyen al terminar; los perfiles viven en el repositorio.
- **El workflow no lo controla el LLM.** El orquestador valida transiciones; los
  agentes solo producen artefactos y recomendaciones.
- **Artefactos como contrato.** Cada paso deja un documento persistido que el
  siguiente agente consume.
- **Aislamiento por worktree.** Nunca dos agentes en el mismo directorio.
- **Puertas deterministas.** Tests y reglas de entrega no dependen del criterio
  del modelo.
- **Aprobación humana en el merge.** La autonomía crece en fases, no de golpe.
