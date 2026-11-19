import type { AgentRuntimePort, AgentRunRequest } from "../ports.ts";
import type { AgentRunResult, ModelRef } from "../domain/types.ts";
import type { OpencodeConfig } from "../config.ts";
import { AgentTimeoutError, ExternalServiceError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { sleep, truncate } from "../util.ts";

type SessionInfo = {
  id: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
};

type MessagePart = {
  type: string;
  text?: string;
};

type SessionMessage = {
  type: string;
  content?: MessagePart[];
  error?: { message?: string };
  time?: { completed?: number };
};

type PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
};

export class OpencodeRuntime implements AgentRuntimePort {
  private readonly authHeader: string | null;
  private readonly activeSessions = new Set<string>();
  private approvalTimer: ReturnType<typeof setInterval> | null = null;
  private approving = false;

  constructor(
    private readonly config: OpencodeConfig,
    private readonly logger: Logger,
  ) {
    this.authHeader = config.password
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
      : null;
  }

  start(): void {
    if (this.approvalTimer) return;
    this.approvalTimer = setInterval(() => {
      void this.approvePendingPermissions();
    }, 1_500);
    this.approvalTimer.unref?.();
  }

  stop(): void {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.approvalTimer = null;
  }

  async health(): Promise<void> {
    await this.request("/api/info");
  }

  async verifyModel(model: ModelRef): Promise<void> {
    const response = await this.request<{
      data: Array<{ providerID: string; id: string; status?: string }>;
    }>("/api/model");
    const found = response.data.some(
      (entry) =>
        entry.providerID === model.providerID &&
        entry.id === model.id &&
        entry.status !== "disabled",
    );
    if (!found) {
      throw new Error(
        `Model ${model.providerID}/${model.id} is not available in OpenCode. ` +
          `Check the provider credentials (for Ollama Cloud: OLLAMA_API_KEY) and ` +
          `that the model ID exists for that provider.`,
      );
    }
    this.logger.info("OpenCode model verified", {
      model: `${model.providerID}/${model.id}`,
    });
  }

  async verifyAgents(agentIds: string[], directory: string): Promise<void> {
    const response = await this.request<{
      data: Array<{ id: string }>;
    }>(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`);
    const available = new Set(response.data.map((agent) => agent.id));

    // The HTTP listing does not always include globally discovered Markdown
    // agents, while session creation does. Probe any agent that is not listed.
    for (const id of agentIds) {
      if (available.has(id)) continue;
      let sessionId: string | null = null;
      try {
        const created = await this.request<{ data: { id: string } }>(
          "/api/session",
          {
            method: "POST",
            body: {
              title: `verify agent ${id}`,
              agent: id,
              location: { directory },
            },
          },
        );
        sessionId = created.data.id;
      } catch (error) {
        throw new Error(
          `OpenCode cannot start agent "${id}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        if (sessionId) {
          await this.request(`/api/session/${sessionId}`, {
            method: "DELETE",
          }).catch(() => undefined);
        }
      }
    }

    this.logger.info("OpenCode agents verified", { agents: agentIds });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const created = await this.request<{ data: SessionInfo }>("/api/session", {
      method: "POST",
      body: {
        title: truncate(`${request.agent}: ${request.title}`, 120),
        agent: request.agent,
        location: { directory: request.directory },
        ...(this.config.model ? { model: this.config.model } : {}),
      },
    });

    const sessionId = created.data.id;
    this.activeSessions.add(sessionId);
    this.start();
    const log = this.logger.child({ session: sessionId, agent: request.agent });
    let completed = false;

    try {
      await this.request(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        body: { text: request.prompt },
        timeoutMs: 60_000,
      });

      const deadline = Date.now() + request.timeoutMs;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AgentTimeoutError(
            `${request.agent} timed out after ${Math.round(request.timeoutMs / 1000)}s`,
          );
        }

        await this.waitForIdle(sessionId, request.timeoutMs, deadline);

        const messages = await this.messages(sessionId);
        const assistant = messages.find((message) => message.type === "assistant");
        const info = await this.sessionInfo(sessionId);

        if (assistant?.error) {
          throw new ExternalServiceError(
            `${request.agent} failed: ${assistant.error.message ?? "unknown model error"}`,
          );
        }

        if (info.outcome === "failed" || info.outcome === "interrupted") {
          throw new ExternalServiceError(
            `${request.agent} session ended with outcome ${info.outcome}`,
          );
        }

        if (assistant?.time?.completed) {
          completed = true;
          const text = this.extractText(assistant);
          log.info("agent finished", {
            characters: text.length,
            cost: info.cost ?? 0,
          });
          return {
            sessionId,
            text,
            cost: info.cost ?? 0,
            tokens: {
              input: info.tokens?.input ?? 0,
              output: info.tokens?.output ?? 0,
              reasoning: info.tokens?.reasoning ?? 0,
            },
          };
        }

        await sleep(400);
      }
    } catch (error) {
      if (!completed) await this.interrupt(sessionId);
      throw error;
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  private async waitForIdle(
    sessionId: string,
    timeoutMs: number,
    deadline: number,
  ): Promise<void> {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.interrupt(sessionId);
        throw new AgentTimeoutError(
          `session ${sessionId} did not become idle within ${Math.round(timeoutMs / 1000)}s`,
        );
      }

      // The OpenCode wait endpoint is a long poll. Use short HTTP waits and
      // retry so a proxy/client header timeout cannot abort the whole step.
      const chunk = Math.min(remaining, 60_000);
      try {
        await this.request(`/api/experimental/session/${sessionId}/wait`, {
          method: "POST",
          timeoutMs: chunk,
        });
        return;
      } catch (error) {
        if (isTimeoutError(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const response = await this.request<{ data: SessionInfo }>(
      `/api/session/${sessionId}`,
    );
    return response.data;
  }

  private async messages(sessionId: string): Promise<SessionMessage[]> {
    const response = await this.request<{ data: SessionMessage[] }>(
      `/api/session/${sessionId}/message?limit=200&order=desc`,
    );
    return response.data;
  }

  private extractText(message: SessionMessage): string {
    const parts = (message.content ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!.trim())
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }

  private async interrupt(sessionId: string): Promise<void> {
    try {
      await this.request(`/api/session/${sessionId}/interrupt`, {
        method: "POST",
        timeoutMs: 10_000,
      });
    } catch (error) {
      this.logger.warn("failed to interrupt session", {
        session: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async approvePendingPermissions(): Promise<void> {
    if (this.approving || this.activeSessions.size === 0) return;
    this.approving = true;
    try {
      for (const sessionId of [...this.activeSessions]) {
        const response = await this.request<{ data: PermissionRequest[] }>(
          `/api/session/${sessionId}/permission`,
          { timeoutMs: 10_000 },
        ).catch(() => null);
        if (!response) continue;

        for (const request of response.data) {
          const decision = this.config.autoApprovePermissions ? "once" : "reject";
          this.logger.info("permission request handled", {
            session: sessionId,
            action: request.action,
            resources: request.resources,
            decision,
          });
          await this.request(
            `/api/session/${sessionId}/permission/${request.id}/reply`,
            {
              method: "POST",
              body: {
                decision,
                message:
                  decision === "once"
                    ? "Approved by the software factory orchestrator"
                    : "Rejected by the software factory orchestrator",
              },
              timeoutMs: 10_000,
            },
          );
        }
      }
    } catch (error) {
      this.logger.warn("permission polling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.approving = false;
    }
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      options.timeoutMs ?? 30_000,
    );

    try {
      const response = await fetch(`${this.config.url}${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 800);
        throw new ExternalServiceError(
          `OpenCode ${options.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`,
          response.status,
        );
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
