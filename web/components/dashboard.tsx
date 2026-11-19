"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signOutClient } from "@/lib/auth/client";
import { ApiError, readJson } from "@/lib/http";
import type { AuthUser, Run, RunResponse, RunsResponse } from "@/lib/types";

const TERMINAL_STATES = new Set(["HUMAN_REVIEW", "DONE", "BLOCKED"]);

export function Dashboard({ user }: { user: AuthUser }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [message, setMessage] = useState<string>("");
  const [isError, setIsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);

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

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

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

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage("");
    setIsError(false);
    setSubmitting(true);

    const payload: Record<string, string> = {
      repoUrl: String(data.get("repoUrl") ?? "").trim(),
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

  async function logout() {
    try {
      await signOutClient();
    } catch {
      window.location.assign("/login");
    }
  }

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">AI Software Factory</p>
          <h1>Iniciar desarrollo de un issue</h1>
          <p className="muted">
            El repo y el issue deben pertenecer al mismo repositorio. La factoría
            crea un worktree aislado, ejecuta el squad y deja el resultado listo
            para revisión.
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
          <form onSubmit={onSubmit}>
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

            <button type="submit" disabled={submitting}>
              {submitting ? "Arrancando…" : "Iniciar desarrollo"}
            </button>
          </form>

          {message ? (
            <div className={`message${isError ? " error" : ""}`} role="status">
              {message}
            </div>
          ) : null}
        </section>

        {selectedRun ? <RunPanel run={selectedRun} /> : null}

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
                  <span className="title">{run.ticket?.title ?? ""}</span>
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

function RunPanel({ run }: { run: Run }) {
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
          <dt>Repo</dt>
          <dd>{run.repoUrl || "—"}</dd>
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
