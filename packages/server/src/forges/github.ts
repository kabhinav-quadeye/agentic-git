import type { CiCheck, CiCheckStatus, DiffFile, MergeMethod } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";
import { MergeConflictError, type ForgeAdapter, type ShadowPrResult } from "./types.js";

function encodeGitRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function parseNextLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function mapGitHubConclusion(status: string, conclusion: string | null): CiCheckStatus {
  if (status === "queued") return "pending";
  if (status === "in_progress") return "running";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "passed";
  if (conclusion === "cancelled") return "cancelled";
  return "failed";
}

function mapGitHubCommitState(state: string): CiCheckStatus {
  if (state === "success") return "passed";
  if (state === "pending") return "pending";
  return "failed";
}

function mapGitHubFileStatus(status: string): DiffFile["status"] {
  if (status === "added") return "added";
  if (status === "removed") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}

export class GitHubForgeAdapter implements ForgeAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private apiBase(repo: RepoRowInternal): string {
    return (repo.forgeBaseUrl || "https://api.github.com").replace(/\/+$/, "");
  }

  private headers(token: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentic-git",
    };
    if (token) h.Authorization = `Bearer ${token}`;
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
      throw new Error(`GitHub API ${res.status} ${url}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async createShadowPr(
    repo: RepoRowInternal,
    token: string,
    params: { title: string; description: string; sourceBranch: string; targetBranch: string },
  ): Promise<ShadowPrResult> {
    const url = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/pulls`;
    const body = {
      title: params.title,
      body: `${params.description}\n\n---\n_Shadow PR managed by agentic-git (CI & merge execution only)._`,
      head: params.sourceBranch,
      base: params.targetBranch,
    };
    const data = await this.requestJson<{
      number: number;
      html_url: string;
      head?: { sha?: string };
    }>(url, token, { method: "POST", body: JSON.stringify(body) });

    return {
      upstreamPrId: String(data.number),
      upstreamPrUrl: data.html_url,
      headSha: data.head?.sha,
    };
  }

  async closeShadowPr(repo: RepoRowInternal, token: string, upstreamPrId: string): Promise<void> {
    const url = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/pulls/${upstreamPrId}`;
    await this.requestJson(url, token, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  async getBranchHeadSha(
    repo: RepoRowInternal,
    token: string,
    branch: string,
  ): Promise<string | null> {
    const url = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/git/ref/heads/${encodeGitRef(branch)}`;
    const res = await this.fetchImpl(url, { headers: this.headers(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ref lookup failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? null;
  }

  async getPrDiff(
    repo: RepoRowInternal,
    token: string,
    params: { upstreamPrId?: string | null; sourceBranch: string; targetBranch: string },
  ): Promise<DiffFile[]> {
    if (params.upstreamPrId) {
      type GitHubFileEntry = {
        filename: string;
        previous_filename?: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      };
      const allFiles: GitHubFileEntry[] = [];
      let nextUrl: string | null =
        `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/pulls/${params.upstreamPrId}/files?per_page=100`;
      const maxPages = 30;
      for (let page = 0; nextUrl && page < maxPages; page++) {
        const res = await this.fetchImpl(nextUrl, { headers: this.headers(token) });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`GitHub API ${res.status} ${nextUrl}: ${text}`);
        }
        const batch = (await res.json()) as GitHubFileEntry[];
        allFiles.push(...batch);
        nextUrl = parseNextLinkHeader(res.headers.get("link"));
      }
      return allFiles.map((f) => ({
        path: f.filename,
        oldPath: f.previous_filename ?? null,
        status: mapGitHubFileStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? "",
      }));
    }

    const url = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/compare/${encodeGitRef(params.targetBranch)}...${encodeGitRef(params.sourceBranch)}`;
    const data = await this.requestJson<{
      files?: Array<{
        filename: string;
        previous_filename?: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>;
    }>(url, token);
    return (data.files ?? []).map((f) => ({
      path: f.filename,
      oldPath: f.previous_filename ?? null,
      status: mapGitHubFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? "",
    }));
  }

  async getCommitChecks(repo: RepoRowInternal, token: string, sha: string): Promise<CiCheck[]> {
    const checks: CiCheck[] = [];
    const now = new Date().toISOString();

    const runsUrl = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/commits/${sha}/check-runs`;
    const runsRes = await this.fetchImpl(runsUrl, { headers: this.headers(token) });
    if (runsRes.ok) {
      const data = (await runsRes.json()) as {
        check_runs?: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          html_url?: string;
          output?: { summary?: string };
          completed_at?: string;
          started_at?: string;
        }>;
      };
      for (const run of data.check_runs ?? []) {
        checks.push({
          name: run.name,
          status: mapGitHubConclusion(run.status, run.conclusion),
          url: run.html_url ?? null,
          summary: run.output?.summary ?? null,
          updatedAt: run.completed_at ?? run.started_at ?? now,
        });
      }
    }

    const statusUrl = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/commits/${sha}/status`;
    const statusRes = await this.fetchImpl(statusUrl, { headers: this.headers(token) });
    if (statusRes.ok) {
      const data = (await statusRes.json()) as {
        statuses?: Array<{
          context: string;
          state: string;
          target_url?: string;
          description?: string;
          updated_at?: string;
        }>;
      };
      for (const st of data.statuses ?? []) {
        checks.push({
          name: st.context,
          status: mapGitHubCommitState(st.state),
          url: st.target_url ?? null,
          summary: st.description ?? null,
          updatedAt: st.updated_at ?? now,
        });
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
      throw new Error("GitHub merge requires an upstream shadow PR number");
    }
    const mergeMethod = params.mergeMethod ?? repo.mergePolicy.mergeMethod ?? "squash";
    const url = `${this.apiBase(repo)}/repos/${repo.upstreamRepo}/pulls/${params.upstreamPrId}/merge`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({
        commit_title: params.commitTitle,
        merge_method: mergeMethod,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 405 || res.status === 409) {
        throw new MergeConflictError(`GitHub rejected merge (${res.status}): ${text}`);
      }
      throw new Error(`GitHub API ${res.status} ${url}: ${text}`);
    }
    const data = (await res.json()) as { sha: string };
    return { mergedSha: data.sha };
  }
}
