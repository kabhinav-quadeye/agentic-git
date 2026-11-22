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
