import crypto from "node:crypto";
import type { CiCheck, CiCheckStatus, WebhookDelivery, WebhookEventType } from "@agentic-git/shared";
import type { Store } from "./db.js";

export function signWebhookPayload(secret: string, body: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = signWebhookPayload(secret, rawBody);
  return timingSafeEqualStrings(expected, signatureHeader.trim());
}

export function verifyGitLabWebhookToken(
  secret: string,
  tokenHeader: string | null | undefined,
): boolean {
  if (!secret || !tokenHeader) return false;
  return timingSafeEqualStrings(secret, tokenHeader.trim());
}

export class WebhookDispatcher {
  private readonly store: Store;
  private readonly fetchImpl: typeof fetch;

  constructor(store: Store, fetchImpl: typeof fetch = fetch) {
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  async emit(
    repoId: string,
    event: WebhookEventType,
    payload: Record<string, unknown>,
    extraTargets?: Array<{ id: string; url: string; secret: string }>,
  ): Promise<WebhookDelivery[]> {
    const subs = this.store
      .listWebhookSubscriptions(repoId)
      .filter((s) => s.enabled && s.events.includes(event));

    const targets: Array<{ id: string; url: string; secret: string }> = [
      ...subs.map((s) => ({ id: s.id, url: s.url, secret: s.secret })),
      ...(extraTargets ?? []),
    ];

    const fullPayload = {
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    const body = JSON.stringify(fullPayload);

    const deliveries: WebhookDelivery[] = [];
    for (const target of targets) {
      const signature = signWebhookPayload(target.secret, body);
      try {
        const res = await this.fetchImpl(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agentic-Git-Event": event,
            "X-Agentic-Git-Signature": signature,
          },
          body,
        });
        const responseBody = await res.text().catch(() => "");
        deliveries.push(
          this.store.recordWebhookDelivery({
            subscriptionId: target.id,
            event,
            url: target.url,
            payload: fullPayload,
            statusCode: res.status,
            responseBody: responseBody.slice(0, 2000),
            error: res.ok ? null : `HTTP ${res.status}`,
          }),
        );
      } catch (err) {
        deliveries.push(
          this.store.recordWebhookDelivery({
            subscriptionId: target.id,
            event,
            url: target.url,
            payload: fullPayload,
            statusCode: null,
            responseBody: null,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    return deliveries;
  }
}

export interface ParsedUpstreamCiUpdate {
  upstreamRepo: string;
  sha: string;
  checks: CiCheck[];
}

export function parseGitHubCiWebhook(
  eventName: string,
  body: Record<string, unknown>,
): ParsedUpstreamCiUpdate | null {
  const repoObj = body.repository as { full_name?: string } | undefined;
  const upstreamRepo = repoObj?.full_name;
  if (!upstreamRepo) return null;
  const now = new Date().toISOString();

  if (eventName === "check_run") {
    const cr = body.check_run as {
      name?: string;
      status?: string;
      conclusion?: string | null;
      head_sha?: string;
      html_url?: string;
      output?: { summary?: string };
    } | undefined;
    if (!cr?.head_sha || !cr.name) return null;
    let status: CiCheckStatus = "pending";
    if (cr.status === "in_progress") status = "running";
    else if (cr.status === "completed") {
      status =
        cr.conclusion === "success" || cr.conclusion === "neutral" || cr.conclusion === "skipped"
          ? "passed"
          : cr.conclusion === "cancelled"
            ? "cancelled"
            : "failed";
    }
    return {
      upstreamRepo,
      sha: cr.head_sha,
      checks: [
        {
          name: cr.name,
          status,
          url: cr.html_url ?? null,
          summary: cr.output?.summary ?? null,
          updatedAt: now,
        },
      ],
    };
  }

  if (eventName === "status") {
    const sha = typeof body.sha === "string" ? body.sha : null;
    const context = typeof body.context === "string" ? body.context : null;
    const state = typeof body.state === "string" ? body.state : null;
    if (!sha || !context || !state) return null;
    const status: CiCheckStatus =
      state === "success" ? "passed" : state === "pending" ? "pending" : "failed";
    return {
      upstreamRepo,
      sha,
      checks: [
        {
          name: context,
          status,
          url: typeof body.target_url === "string" ? body.target_url : null,
          summary: typeof body.description === "string" ? body.description : null,
          updatedAt: now,
        },
      ],
    };
  }

  return null;
}

export function parseGitLabCiWebhook(
  body: Record<string, unknown>,
): ParsedUpstreamCiUpdate | null {
  const project = body.project as { path_with_namespace?: string } | undefined;
  const upstreamRepo = project?.path_with_namespace;
  if (!upstreamRepo) return null;
  const now = new Date().toISOString();
  const objectKind = typeof body.object_kind === "string" ? body.object_kind : "";

  const mapStatus = (s: string): CiCheckStatus => {
    if (s === "success") return "passed";
    if (s === "running") return "running";
    if (s === "pending" || s === "created") return "pending";
    if (s === "canceled" || s === "cancelled" || s === "skipped") return "cancelled";
    return "failed";
  };

  if (objectKind === "pipeline") {
    const attrs = body.object_attributes as { id?: number; sha?: string; status?: string; url?: string } | undefined;
    if (!attrs?.sha || !attrs.status) return null;
    return {
      upstreamRepo,
      sha: attrs.sha,
      checks: [
        {
          name: `gitlab-pipeline`,
          status: mapStatus(attrs.status),
          url: attrs.url ?? null,
          summary: `Pipeline #${attrs.id ?? ""} (${attrs.status})`,
          updatedAt: now,
        },
      ],
    };
  }

  if (objectKind === "build") {
    const sha = typeof body.sha === "string" ? body.sha : null;
    const buildName = typeof body.build_name === "string" ? body.build_name : null;
    const buildStatus = typeof body.build_status === "string" ? body.build_status : null;
    if (!sha || !buildName || !buildStatus) return null;
    return {
      upstreamRepo,
      sha,
      checks: [
        {
          name: buildName,
          status: mapStatus(buildStatus),
          url: null,
          summary: `GitLab job ${buildName} (${buildStatus})`,
          updatedAt: now,
        },
      ],
    };
  }

  return null;
}
