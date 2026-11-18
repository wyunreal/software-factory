const form = document.getElementById("run-form");
const submit = document.getElementById("submit");
const message = document.getElementById("message");
const panel = document.getElementById("run-panel");
const runsEl = document.getElementById("runs");
const refresh = document.getElementById("refresh");

let pollTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");
  submit.disabled = true;
  submit.textContent = "Arrancando…";

  const payload = {
    repoUrl: value("repoUrl"),
    issueUrl: value("issueUrl"),
    baseBranch: value("baseBranch") || "main",
  };
  const setupCommand = value("setupCommand");
  const testCommand = value("testCommand");
  if (setupCommand) payload.setupCommand = setupCommand;
  if (testCommand) payload.testCommand = testCommand;

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    setMessage(`Ejecución creada: ${body.data.id}`);
    showRun(body.data);
    await loadRuns();
    poll(body.data.id);
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    submit.disabled = false;
    submit.textContent = "Iniciar desarrollo";
  }
});

refresh.addEventListener("click", () => void loadRuns());

async function loadRuns() {
  try {
    const response = await fetch("/api/runs?limit=10");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderRuns(body.data || []);
  } catch (error) {
    runsEl.innerHTML = `<p class="muted">No se pudieron cargar las ejecuciones: ${escapeHtml(
      error.message || String(error),
    )}</p>`;
  }
}

function renderRuns(runs) {
  if (runs.length === 0) {
    runsEl.innerHTML = '<p class="muted">Todavía no hay ejecuciones.</p>';
    return;
  }
  runsEl.innerHTML = runs
    .map(
      (run) => `
      <div class="run-row" data-id="${escapeHtml(run.id)}">
        <span class="ref">${escapeHtml(run.ticket?.ref || "")}</span>
        <span class="title">${escapeHtml(run.ticket?.title || "")}</span>
        <span class="state">${escapeHtml(run.state)}</span>
      </div>`,
    )
    .join("");

  for (const row of runsEl.querySelectorAll(".run-row")) {
    row.addEventListener("click", () => {
      poll(row.dataset.id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
}

async function poll(id) {
  if (!id) return;
  if (pollTimer) clearTimeout(pollTimer);

  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const run = body.data;
    showRun(run);

    if (!["HUMAN_REVIEW", "DONE", "BLOCKED"].includes(run.state)) {
      pollTimer = setTimeout(() => poll(id), 3000);
    }
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

function showRun(run) {
  panel.hidden = false;
  document.getElementById("run-title").textContent = run.ticket?.title || "—";
  const state = document.getElementById("run-state");
  state.textContent = run.state;
  state.className = `badge ${String(run.state).toLowerCase()}`;
  document.getElementById("run-id").textContent = run.id;
  document.getElementById("run-repo").textContent = run.repoUrl || "—";
  document.getElementById("run-branch").textContent = run.branch || "—";

  const pr = document.getElementById("run-pr");
  if (run.prUrl) {
    pr.innerHTML = `<a href="${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
      run.prUrl,
    )}</a>`;
  } else {
    pr.textContent = "—";
  }

  const block = document.getElementById("run-block");
  if (run.blockReason) {
    block.textContent = run.blockReason;
    block.classList.remove("hidden");
  } else {
    block.classList.add("hidden");
  }

  const artifacts = document.getElementById("artifacts");
  artifacts.innerHTML = (run.artifacts || [])
    .map((artifact) => `<span class="chip">${escapeHtml(artifact.name)}</span>`)
    .join("");
}

function value(id) {
  return document.getElementById(id).value.trim();
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("hidden", !text);
  message.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadRuns();
