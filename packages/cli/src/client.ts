import type { AgitConfig } from "./config.js";

export class AgitApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class AgitClient {
  private readonly cfg: AgitConfig;

  constructor(cfg: AgitConfig) {
    this.cfg = cfg;
  }

  async request<T>(method: string, routePath: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.cfg.token) {
      headers.Authorization = `Bearer ${this.cfg.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(`${this.cfg.serverUrl}${routePath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach agentic-git server at ${this.cfg.serverUrl} (${reason}). Start the server or run \`agit auth login --server <url> --token <token>\`.`,
      );
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const msg =
        typeof json === "object" && json && "error" in json
          ? String((json as { error: unknown }).error)
          : `HTTP ${res.status}: ${text}`;
      throw new AgitApiError(res.status, msg, json);
    }

    return json as T;
  }
}
