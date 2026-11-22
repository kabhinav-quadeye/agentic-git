import type { CiCheck, CiCheckStatus, DiffFile, MergeMethod } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";
import { MergeConflictError, type ForgeAdapter, type ShadowPrResult } from "./types.js";

function mapGitLabStatus(state: string): CiCheckStatus {
  if (state === "success") return "passed";
  if (state === "running") return "running";
  if (state === "pending" || state === "created" || state === "waiting_for_resource" || state === "preparing") {
    return "pending";
  }
  if (state === "canceled" || state === "cancelled" || state === "skipped") return "cancelled";
  return "failed";
}

function countPatchLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export class GitLabForgeAdapter implements ForgeAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private apiBase(repo: RepoRowInternal): string {
    const base = (repo.forgeBaseUrl || "https://gitlab.com").replace(/\/+$/, "");
    return base.endsWith("/api/v4") ? base : `${base}/api/v4`;
  }

  private projectPath(repo: RepoRowInternal): string {
    return encodeURIComponent(repo.upstreamRepo);
  }

  private headers(token: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "agentic-git",
    };
    if (token) {
      h["PRIVATE-TOKEN"] = token;
    }
    return h;
  }

  private async requestJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...this.headers(token),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab API ${res.status} ${url}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async createShadowPr(
    repo: RepoRowInternal,
    token: string,
    params: { title: string; description: string; sourceBranch: string; targetBranch: string },
  ): Promise<ShadowPrResult> {
    const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/merge_requests`;
    const data = await this.requestJson<{
      iid: number;
      web_url: string;
      sha?: string;
    }>(url, token, {
      method: "POST",
      body: JSON.stringify({
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
        title: params.title,
        description: `${params.description}\n\n---\n_Shadow MR managed by agentic-git (CI & merge execution only)._`,
      }),
    });
    return {
      upstreamPrId: String(data.iid),
      upstreamPrUrl: data.web_url,
      headSha: data.sha,
    };
  }

  async closeShadowPr(repo: RepoRowInternal, token: string, upstreamPrId: string): Promise<void> {
    const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/merge_requests/${upstreamPrId}`;
    await this.requestJson(url, token, {
      method: "PUT",
      body: JSON.stringify({ state_event: "close" }),
    });
  }

  async getBranchHeadSha(
    repo: RepoRowInternal,
    token: string,
    branch: string,
  ): Promise<string | null> {
    const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/repository/branches/${encodeURIComponent(branch)}`;
    const res = await this.fetchImpl(url, { headers: this.headers(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitLab branch lookup failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { commit?: { id?: string } };
    return data.commit?.id ?? null;
  }

  async getPrDiff(
    repo: RepoRowInternal,
    token: string,
    params: { upstreamPrId?: string | null; sourceBranch: string; targetBranch: string },
  ): Promise<DiffFile[]> {
    interface GitLabChange {
      old_path: string;
      new_path: string;
      new_file: boolean;
      renamed_file: boolean;
      deleted_file: boolean;
      diff: string;
    }

    let changes: GitLabChange[] = [];
    if (params.upstreamPrId) {
      const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/merge_requests/${params.upstreamPrId}/changes`;
      const data = await this.requestJson<{ changes?: GitLabChange[] }>(url, token);
      changes = data.changes ?? [];
    } else {
      const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/repository/compare?from=${encodeURIComponent(params.targetBranch)}&to=${encodeURIComponent(params.sourceBranch)}`;
      const data = await this.requestJson<{ diffs?: GitLabChange[] }>(url, token);
      changes = data.diffs ?? [];
    }

    return changes.map((c) => {
      const { additions, deletions } = countPatchLines(c.diff ?? "");
      const status: DiffFile["status"] = c.new_file
        ? "added"
        : c.deleted_file
          ? "deleted"
          : c.renamed_file
            ? "renamed"
            : "modified";
      return {
        path: c.new_path,
        oldPath: c.renamed_file ? c.old_path : null,
        status,
        additions,
        deletions,
        patch: c.diff ?? "",
      };
    });
  }

  async getCommitChecks(repo: RepoRowInternal, token: string, sha: string): Promise<CiCheck[]> {
    const now = new Date().toISOString();
    const checks: CiCheck[] = [];

    const statusesUrl = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/repository/commits/${sha}/statuses`;
    const statusesRes = await this.fetchImpl(statusesUrl, { headers: this.headers(token) });
    if (statusesRes.ok) {
      const list = (await statusesRes.json()) as Array<{
        name: string;
        status: string;
        target_url?: string;
        description?: string;
        finished_at?: string;
        created_at?: string;
      }>;
      for (const s of list) {
        checks.push({
          name: s.name,
          status: mapGitLabStatus(s.status),
          url: s.target_url ?? null,
          summary: s.description ?? null,
          updatedAt: s.finished_at ?? s.created_at ?? now,
        });
      }
    }

    if (checks.length === 0) {
      const pipeUrl = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/pipelines?sha=${sha}`;
      const pipeRes = await this.fetchImpl(pipeUrl, { headers: this.headers(token) });
      if (pipeRes.ok) {
        const pipes = (await pipeRes.json()) as Array<{
          id: number;
          status: string;
          web_url?: string;
          updated_at?: string;
        }>;
        for (const p of pipes.slice(0, 1)) {
          checks.push({
            name: `gitlab-pipeline-${p.id}`,
            status: mapGitLabStatus(p.status),
            url: p.web_url ?? null,
            summary: `GitLab pipeline #${p.id} (${p.status})`,
            updatedAt: p.updated_at ?? now,
          });
        }
      }
    }

    return checks;
  }

  async mergePr(
    repo: RepoRowInternal,
    token: string,
    params: {
      upstreamPrId?: string | null;
      sourceBranch: string;
      targetBranch: string;
      commitTitle: string;
      mergeMethod?: MergeMethod;
    },
  ): Promise<{ mergedSha: string }> {
    if (!params.upstreamPrId) {
      throw new Error("GitLab merge requires an upstream shadow MR IID");
    }
    const mergeMethod = params.mergeMethod ?? repo.mergePolicy.mergeMethod ?? "squash";
    const url = `${this.apiBase(repo)}/projects/${this.projectPath(repo)}/merge_requests/${params.upstreamPrId}/merge`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({
        merge_commit_message: params.commitTitle,
        squash: mergeMethod === "squash",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 405 || res.status === 406 || res.status === 409) {
        throw new MergeConflictError(`GitLab rejected merge (${res.status}): ${text}`);
      }
      throw new Error(`GitLab API ${res.status} ${url}: ${text}`);
    }
    const data = (await res.json()) as { merge_commit_sha?: string; sha?: string };
    return { mergedSha: data.merge_commit_sha ?? data.sha ?? "" };
  }
}
