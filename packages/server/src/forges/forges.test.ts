import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MERGE_POLICY } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";
import { GitHubForgeAdapter } from "./github.js";
import { GitLabForgeAdapter } from "./gitlab.js";

function makeRepo(overrides: Partial<RepoRowInternal>): RepoRowInternal {
  return {
    id: "rep_1",
    slug: "acme/service",
    forgeType: "github",
    forgeBaseUrl: "",
    upstreamRepo: "acme/service",
    upstreamGitUrl: "https://github.com/acme/service.git",
    upstreamToken: "tok_upstream",
    incomingWebhookSecret: "",
    defaultBranch: "main",
    credentialMode: "service",
    protectedBranches: ["main"],
    mergePolicy: DEFAULT_MERGE_POLICY,
    diffFilterRules: [],
    customCommentTypes: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("GitHubForgeAdapter", () => {
  it("creates shadow PR, fetches files/checks, and merges via GitHub REST API", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") });

      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            number: 17,
            html_url: "https://github.com/acme/service/pull/17",
            head: { sha: "abc1234" },
          }),
          { status: 201 },
        );
      }
      if (url.includes("/pulls/17/files")) {
        return new Response(
          JSON.stringify([
            { filename: "src/index.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ +a" },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ name: "gh-actions/test", status: "completed", conclusion: "success" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }
      if (url.endsWith("/pulls/17/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ sha: "merged_gh_sha" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const adapter = new GitHubForgeAdapter(mockFetch as unknown as typeof fetch);
    const repo = makeRepo({ forgeType: "github", upstreamRepo: "acme/service" });

    const shadow = await adapter.createShadowPr(repo, "ghp_secret", {
      title: "Feature X",
      description: "Details",
      sourceBranch: "agent/x",
      targetBranch: "main",
    });
    expect(shadow).toEqual({
      upstreamPrId: "17",
      upstreamPrUrl: "https://github.com/acme/service/pull/17",
      headSha: "abc1234",
    });

    const diff = await adapter.getPrDiff(repo, "ghp_secret", {
      upstreamPrId: "17",
      sourceBranch: "agent/x",
      targetBranch: "main",
    });
    expect(diff).toHaveLength(1);
    expect(diff[0].path).toBe("src/index.ts");

    const checks = await adapter.getCommitChecks(repo, "ghp_secret", "abc1234");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "gh-actions/test", status: "passed" });

    const merged = await adapter.mergePr(repo, "ghp_secret", {
      upstreamPrId: "17",
      sourceBranch: "agent/x",
      targetBranch: "main",
      commitTitle: "Feature X (#1)",
    });
    expect(merged.mergedSha).toBe("merged_gh_sha");
    expect(calls.every((c) => c.auth === "Bearer ghp_secret")).toBe(true);
  });

  it("preserves slashes when encoding branch refs for getBranchHeadSha and compare diffs", async () => {
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/git/ref/heads/")) {
        return new Response(JSON.stringify({ object: { sha: "sha_slash_1" } }), { status: 200 });
      }
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const adapter = new GitHubForgeAdapter(mockFetch as unknown as typeof fetch);
    const repo = makeRepo({ forgeType: "github", upstreamRepo: "acme/service" });

    const sha = await adapter.getBranchHeadSha(repo, "ghp_secret", "agent/claude/fix #1");
    expect(sha).toBe("sha_slash_1");
    await adapter.getPrDiff(repo, "ghp_secret", {
      sourceBranch: "agent/claude/fix-1",
      targetBranch: "release/v2",
    });

    expect(requestedUrls[0]).toBe(
      "https://api.github.com/repos/acme/service/git/ref/heads/agent/claude/fix%20%231",
    );
    expect(requestedUrls[1]).toBe(
      "https://api.github.com/repos/acme/service/compare/release/v2...agent/claude/fix-1",
    );
  });

  it("paginates PR diff files across Link rel=next pages", async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("page=2")) {
        return new Response(
          JSON.stringify([
            { filename: "src/file2.ts", status: "added", additions: 2, deletions: 0, patch: "+b" },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          { filename: "src/file1.ts", status: "modified", additions: 1, deletions: 0, patch: "+a" },
        ]),
        {
          status: 200,
          headers: {
            Link: '<https://api.github.com/repos/acme/service/pulls/17/files?per_page=100&page=2>; rel="next", <https://api.github.com/repos/acme/service/pulls/17/files?per_page=100&page=2>; rel="last"',
          },
        },
      );
    });

    const adapter = new GitHubForgeAdapter(mockFetch as unknown as typeof fetch);
    const repo = makeRepo({ forgeType: "github", upstreamRepo: "acme/service" });
    const files = await adapter.getPrDiff(repo, "ghp_secret", {
      upstreamPrId: "17",
      sourceBranch: "agent/x",
      targetBranch: "main",
    });
    expect(files.map((f) => f.path)).toEqual(["src/file1.ts", "src/file2.ts"]);
  });

  it("honors configurable mergeMethod and throws a 409 conflict error when GitHub rejects merge", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(parsed);
      if (parsed.merge_method === "rebase") {
        return new Response(JSON.stringify({ message: "Pull Request is not mergeable" }), { status: 405 });
      }
      return new Response(JSON.stringify({ sha: "merged_merge_commit" }), { status: 200 });
    });

    const adapter = new GitHubForgeAdapter(mockFetch as unknown as typeof fetch);
    const repo = makeRepo({
      forgeType: "github",
      upstreamRepo: "acme/service",
      mergePolicy: { ...DEFAULT_MERGE_POLICY, mergeMethod: "merge" } as typeof DEFAULT_MERGE_POLICY,
    });

    const res = await adapter.mergePr(repo, "ghp_secret", {
      upstreamPrId: "17",
      sourceBranch: "agent/x",
      targetBranch: "main",
      commitTitle: "Merge PR #17",
    });
    expect(res.mergedSha).toBe("merged_merge_commit");
    expect(bodies[0].merge_method).toBe("merge");

    await expect(
      adapter.mergePr(repo, "ghp_secret", {
        upstreamPrId: "17",
        sourceBranch: "agent/x",
        targetBranch: "main",
        commitTitle: "Rebase PR #17",
        mergeMethod: "rebase",
      } as Parameters<typeof adapter.mergePr>[2]),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("GitLabForgeAdapter (cloud & self-hosted)", () => {
  it("supports custom self-hosted base URLs and nested project paths", async () => {
    const calls: Array<{ url: string; method: string; token: string | null }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", token: headers.get("private-token") });

      if (url.endsWith("/merge_requests") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            iid: 9,
            web_url: "https://gitlab.internal.corp/org/team/app/-/merge_requests/9",
            sha: "gl_sha_1",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/merge_requests/9/changes")) {
        return new Response(
          JSON.stringify({
            changes: [
              {
                old_path: "app.ts",
                new_path: "app.ts",
                new_file: false,
                renamed_file: false,
                deleted_file: false,
                diff: "@@ -1 +1,2 @@\n-old\n+new\n+line2",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/commits/gl_sha_1/statuses")) {
        return new Response(
          JSON.stringify([{ name: "gitlab-ci/unit", status: "success" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/merge_requests/9/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ merge_commit_sha: "merged_gl_sha" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const adapter = new GitLabForgeAdapter(mockFetch as unknown as typeof fetch);
    const repo = makeRepo({
      forgeType: "gitlab",
      forgeBaseUrl: "https://gitlab.internal.corp",
      upstreamRepo: "org/team/app",
      upstreamGitUrl: "https://gitlab.internal.corp/org/team/app.git",
    });

    const shadow = await adapter.createShadowPr(repo, "glpat_tok", {
      title: "MR from agent",
      description: "",
      sourceBranch: "agent/mr",
      targetBranch: "main",
    });
    expect(shadow.upstreamPrId).toBe("9");
    expect(calls[0].url).toBe(
      "https://gitlab.internal.corp/api/v4/projects/org%2Fteam%2Fapp/merge_requests",
    );

    const diff = await adapter.getPrDiff(repo, "glpat_tok", {
      upstreamPrId: "9",
      sourceBranch: "agent/mr",
      targetBranch: "main",
    });
    expect(diff[0]).toMatchObject({ path: "app.ts", additions: 2, deletions: 1 });

    const checks = await adapter.getCommitChecks(repo, "glpat_tok", "gl_sha_1");
    expect(checks[0]).toMatchObject({ name: "gitlab-ci/unit", status: "passed" });

    const merged = await adapter.mergePr(repo, "glpat_tok", {
      upstreamPrId: "9",
      sourceBranch: "agent/mr",
      targetBranch: "main",
      commitTitle: "MR from agent (#1)",
    });
    expect(merged.mergedSha).toBe("merged_gl_sha");
    expect(calls.every((c) => c.token === "glpat_tok")).toBe(true);
  });
});
