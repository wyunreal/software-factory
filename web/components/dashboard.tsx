"use client";

import { useCallback, useEffect, useState } from "react";
import { signOutClient } from "@/lib/auth/client";
import { ApiError, readJson } from "@/lib/http";
import type {
  AuthUser,
  Project,
  ProjectResponse,
  ProjectsResponse,
  Run,
  RunResponse,
  RunsResponse,
} from "@/lib/types";

const TERMINAL_STATES = new Set(["HUMAN_REVIEW", "DONE", "BLOCKED"]);

export function Dashboard({
  user,
  notice,
  noticeError,
}: {
  user: AuthUser;
  notice?: string;
  noticeError?: string;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [message, setMessage] = useState<string>("");
  const [isError, setIsError] = useState(false);
  const [projectMessage, setProjectMessage] = useState<string>(
    noticeError ?? notice ?? "",
  );
  const [projectIsError, setProjectIsError] = useState(Boolean(noticeError));
  const [submitting, setSubmitting] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const response = await fetch("/api/runs?limit=10", { cache: "no-store" });
      const body = await readJson<RunsResponse>(response);
      setRuns(body.data ?? []);
    } catch (error) {
      setMessage(errorText(error));
      setIsError(true);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const body = await readJson<ProjectsResponse>(response);
      const next = body.data ?? [];
      setProjects(next);
      setSelectedProjectId((current) =>
        next.some((project) => project.id === current)
          ? current
          : (next[0]?.id ?? ""),
      );
    } catch (error) {
      setProjectMessage(errorText(error));
      setProjectIsError(true);
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    void loadProjects();
  }, [loadRuns, loadProjects]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(selectedId)}`,
          { cache: "no-store" },
        );
        const body = await readJson<RunResponse>(response);
        if (cancelled) return;
        setSelectedRun(body.data);
        if (!TERMINAL_STATES.has(body.data.state)) {
          timer = setTimeout(tick, 3_000);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(errorText(error));
          setIsError(true);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId]);

  async function onCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const repoUrl = String(data.get("repoUrl") ?? "").trim();
    setProjectMessage("");
    setProjectIsError(false);
    setCreatingProject(true);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, repoUrl }),
      });
      const body = await readJson<ProjectResponse>(response);
      setProjects((current) => [...current, body.data]);
      setSelectedProjectId(body.data.id);
      setProjectMessage(`Proyecto creado: ${body.data.name}`);
      form.reset();
    } catch (error) {
      const body = error instanceof ApiError ? error.body : null;
      if (
        error instanceof ApiError &&
        error.status === 428 &&
        isRecord(body) &&
        body.code === "github_app_not_installed"
      ) {
        setProjectMessage(
          "Instala la GitHub App en el repositorio para crear el proyecto…",
        );
        try {
          const response = await fetch("/api/github/install/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, repoUrl }),
          });
          const start = await readJson<{ installUrl: string }>(response);
          window.location.assign(start.installUrl);
          return;
        } catch (installError) {
          setProjectMessage(errorText(installError));
          setProjectIsError(true);
          setCreatingProject(false);
          return;
        }
      }
      setProjectMessage(errorText(error));
      setProjectIsError(true);
    } finally {
      setCreatingProject(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage("");
    setIsError(false);

    if (!selectedProjectId) {
      setMessage("Crea un proyecto antes de lanzar un issue.");
      setIsError(true);
      return;
    }

    setSubmitting(true);
    const payload: Record<string, string> = {
      projectId: selectedProjectId,
      issueUrl: String(data.get("issueUrl") ?? "").trim(),
      baseBranch: String(data.get("baseBranch") ?? "").trim() || "main",
    };
    const setupCommand = String(data.get("setupCommand") ?? "").trim();
    const testCommand = String(data.get("testCommand") ?? "").trim();
    if (setupCommand) payload.setupCommand = setupCommand;
    if (testCommand) payload.testCommand = testCommand;

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson<RunResponse>(response);
      setMessage(`Ejecución creada: ${body.data.id}`);
      setIsError(false);
      setSelectedRun(body.data);
      setSelectedId(body.data.id);
      await loadRuns();
    } catch (error) {
      setMessage(errorText(error));
      setIsError(true);
    } finally {
      setSubmitting(false);
    }
  }

  function selectRun(id: string) {
    setSelectedRun(null);
    setSelectedId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function projectName(run: Run): string {
    return (
      projects.find((project) => project.id === run.projectId)?.name ?? "—"
    );
  }

  async function logout() {
    try {
      await signOutClient();
    } catch {
      window.location.assign("/login");
    }
  }

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">AI Software Factory</p>
          <h1>Iniciar desarrollo de un issue</h1>
          <p className="muted">
            Cada issue se lanza dentro de un proyecto. El issue debe pertenecer
            al repositorio del proyecto seleccionado. La factoría crea un
            worktree aislado, ejecuta el squad y deja el resultado listo para
            revisión.
          </p>
        </div>
        <div className="header-actions">
          <span className="user">{user.name || user.email}</span>
          <a className="pill" href="/api/runs" target="_blank" rel="noreferrer">
            API runs
          </a>
          <button className="ghost" type="button" onClick={() => void logout()}>
            Salir
          </button>
        </div>
      </header>

      <main>
        <section className="card">
          <div className="run-header">
            <div>
              <p className="eyebrow">Proyectos</p>
              <h2>Tus proyectos</h2>
            </div>
            <button
              className="ghost"
              type="button"
              onClick={() => void loadProjects()}
              disabled={loadingProjects}
            >
              {loadingProjects ? "Cargando…" : "Refrescar"}
            </button>
          </div>

          <div className="projects">
            {projects.length === 0 ? (
              <p className="muted">
                Todavía no tienes proyectos. Crea uno con su repositorio para
                poder lanzar issues.
              </p>
            ) : (
              projects.map((project) => (
                <div
                  className={`project-row${
                    project.id === selectedProjectId ? " selected" : ""
                  }`}
                  key={project.id}
                >
                  <span className="project-name">{project.name}</span>
                  <span className="project-repo">{project.repo}</span>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    {project.id === selectedProjectId ? "Seleccionado" : "Usar"}
                  </button>
                </div>
              ))
            )}
          </div>

          <form className="project-form" onSubmit={onCreateProject}>
            <label>
              Nombre del proyecto
              <input
                name="name"
                type="text"
                maxLength={80}
                placeholder="Mi producto"
                autoComplete="off"
                required
              />
            </label>
            <label>
              Repositorio
              <input
                name="repoUrl"
                type="text"
                placeholder="https://github.com/owner/repo"
                autoComplete="off"
                required
              />
            </label>
            <button type="submit" disabled={creatingProject}>
              {creatingProject ? "Creando…" : "Crear proyecto"}
            </button>
          </form>

          {projectMessage ? (
            <div
              className={`message${projectIsError ? " error" : ""}`}
              role="status"
            >
              {projectMessage}
            </div>
          ) : null}
        </section>

        <section className="card">
          <form onSubmit={onSubmit}>
            <label>
              Proyecto
              <select
                name="projectId"
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                required
                disabled={projects.length === 0}
              >
                {projects.length === 0 ? (
                  <option value="">Sin proyectos</option>
                ) : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} — {project.repo}
                  </option>
                ))}
              </select>
            </label>

            {selectedProject ? (
              <p className="muted">
                Los issues deben pertenecer a{" "}
                <strong>{selectedProject.repo}</strong>.
              </p>
            ) : null}

            <label>
              URL del issue
              <input
                name="issueUrl"
                type="url"
                placeholder="https://github.com/owner/repo/issues/123"
                autoComplete="off"
                required
              />
            </label>

            <label>
              Rama base
              <input name="baseBranch" type="text" defaultValue="main" />
            </label>

            <details>
              <summary>Opciones avanzadas</summary>
              <p className="muted">
                Los agentes detectan el toolchain del repo. Si rellenas estos
                campos, se pasan solo como pistas para esta ejecución.
              </p>
              <label>
                Comando de instalación
                <input
                  name="setupCommand"
                  type="text"
                  placeholder="npm install"
                />
              </label>
              <label>
                Comando de tests
                <input name="testCommand" type="text" placeholder="npm test" />
              </label>
            </details>

            <button
              type="submit"
              disabled={submitting || projects.length === 0}
            >
              {submitting ? "Arrancando…" : "Iniciar desarrollo"}
            </button>
          </form>

          {message ? (
            <div className={`message${isError ? " error" : ""}`} role="status">
              {message}
            </div>
          ) : null}
        </section>

        {selectedRun ? (
          <RunPanel
            run={selectedRun}
            project={
              projects.find((project) => project.id === selectedRun.projectId) ??
              null
            }
          />
        ) : null}

        <section className="card">
          <div className="run-header">
            <h2>Tus ejecuciones</h2>
            <button
              className="ghost"
              type="button"
              onClick={() => void loadRuns()}
              disabled={loadingRuns}
            >
              {loadingRuns ? "Cargando…" : "Refrescar"}
            </button>
          </div>
          <div className="runs">
            {runs.length === 0 ? (
              <p className="muted">Todavía no has creado ejecuciones.</p>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="run-row"
                  onClick={() => selectRun(run.id)}
                >
                  <span className="ref">{run.ticket?.ref ?? ""}</span>
                  <span className="title">
                    {run.ticket?.title ?? ""}
                    <small className="project-name">
                      {projectName(run)}
                    </small>
                  </span>
                  <span className="state">{run.state}</span>
                </button>
              ))
            )}
          </div>
        </section>
      </main>
    </>
  );
}

function RunPanel({ run, project }: { run: Run; project: Project | null }) {
  return (
    <section className="card">
      <div className="run-header">
        <div>
          <p className="eyebrow">Ejecución</p>
          <h2>{run.ticket?.title || "—"}</h2>
        </div>
        <span className={`badge ${run.state.toLowerCase()}`}>{run.state}</span>
      </div>

      <dl className="meta">
        <div>
          <dt>Run</dt>
          <dd>{run.id}</dd>
        </div>
        <div>
          <dt>Proyecto</dt>
          <dd>{project?.name ?? "—"}</dd>
        </div>
        <div>
          <dt>Repo</dt>
          <dd>{project?.repoUrl || run.repoUrl || "—"}</dd>
        </div>
        <div>
          <dt>Rama</dt>
          <dd>{run.branch || "—"}</dd>
        </div>
        <div>
          <dt>PR</dt>
          <dd>
            {run.prUrl ? (
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                {run.prUrl}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {run.blockReason ? <p className="block">{run.blockReason}</p> : null}

      {run.artifacts?.length ? (
        <div className="chips">
          {run.artifacts.map((artifact) => (
            <span className="chip" key={artifact.name}>
              {artifact.name}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
