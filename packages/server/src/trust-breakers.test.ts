import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { startLocalGitHttpServer } from "./local-git-http.js";
import { signWebhookPayload } from "./webhooks.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

describe("Critical trust-breakers (end-to-end)", () => {
  let tmpRoot: string;
  let upstreamRoot: string;
  let bareRepoPath: string;
  let upstreamGitServer: Awaited<ReturnType<typeof startLocalGitHttpServer>>;
  let agitServer: ReturnType<typeof serve>;
  let agitUrl: string;
  let adminToken: string;
  let aliceToken: string;
  let coderToken: string;
  let reviewerToken: string;

  async function api<T>(
    token: string | null,
    method: string,
    route: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${agitUrl}${route}`, {
      method,
      headers,
      body: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agit-trust-"));
    upstreamRoot = path.join(tmpRoot, "upstream");
    bareRepoPath = path.join(upstreamRoot, "acme", "core.git");
    await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });

    await git(tmpRoot, ["init", "--bare", "--initial-branch=main", bareRepoPath]);
    const seed = path.join(tmpRoot, "seed");
    await fs.mkdir(seed);
    await git(seed, ["init", "--initial-branch=main"]);
    await git(seed, ["config", "user.name", "Seed"]);
    await git(seed, ["config", "user.email", "seed@acme.dev"]);
    await fs.writeFile(path.join(seed, "app.ts"), "export const v = 1;\n");
    await fs.writeFile(path.join(seed, "conflict.txt"), "base\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-m", "init"]);
    await git(seed, ["remote", "add", "origin", bareRepoPath]);
    await git(seed, ["push", "-u", "origin", "main"]);

    upstreamGitServer = await startLocalGitHttpServer({ projectRoot: upstreamRoot });

    const ctx = createApp({ dbPath: path.join(tmpRoot, "trust.db") });
    adminToken = ctx.adminToken;
    agitServer = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => agitServer.once("listening", resolve));
    const addr = agitServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    agitUrl = `http://127.0.0.1:${port}`;

    const alice = await api<{ token: string }>(adminToken, "POST", "/api/actors", {
      handle: "alice",
      displayName: "Alice Maintainer",
      type: "human",
      role: "maintainer",
      canMerge: true,
      canApprove: true,
    });
    aliceToken = alice.data.token;

    const coder = await api<{ token: string }>(aliceToken, "POST", "/api/actors", {
      handle: "coder-bot",
      displayName: "Coder Bot",
      type: "agent",
      role: "agent",
      allowedBranchPatterns: ["agent/**"],
      canMerge: false,
      canApprove: true,
    });
    coderToken = coder.data.token;

    const reviewer = await api<{ token: string }>(aliceToken, "POST", "/api/actors", {
      handle: "review-bot",
      displayName: "Review Bot",
      type: "agent",
      role: "agent",
      allowedBranchPatterns: ["agent/**"],
      canMerge: false,
      canApprove: true,
    });
    reviewerToken = reviewer.data.token;

    const repo = await api(aliceToken, "POST", "/api/repos", {
      slug: "acme/core",
      forgeType: "local",
      forgeBaseUrl: "local://upstream",
      upstreamRepo: bareRepoPath,
      upstreamGitUrl: `${upstreamGitServer.url}/acme/core.git`,
      upstreamToken: "",
      defaultBranch: "main",
      protectedBranches: ["main"],
      mergePolicy: {
        requireCiPassed: true,
        requiredChecks: ["ci/test"],
        minApprovals: 1,
        invalidateApprovalsOnPush: true,
      },
    });
    expect(repo.status).toBe(201);
  });

  afterAll(async () => {
    agitServer.close();
    await upstreamGitServer.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("clears stale CI checks when a new commit is pushed to an open PR", async () => {
    const work = path.join(tmpRoot, "work-stale-ci");
    const url = agitUrl.replace("http://", `http://coder-bot:${coderToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Coder"]);
    await git(work, ["config", "user.email", "coder@acme.dev"]);
    await git(work, ["checkout", "-b", "agent/stale-ci"]);
    await fs.writeFile(path.join(work, "stale.ts"), "export const a = 1;\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "commit 1"]);
    await git(work, ["push", "-u", "origin", "agent/stale-ci"]);

    const created = await api<{ pr: { number: number; headSha: string } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "Stale CI test", sourceBranch: "agent/stale-ci" },
    );
    expect(created.status).toBe(201);
    const prNum = created.data.pr.number;

    await api(adminToken, "POST", `/api/repos/acme/core/prs/${prNum}/ci`, {
      checks: [{ name: "ci/test", status: "passed", updatedAt: new Date().toISOString() }],
    });
    const gateBefore = await api<{ gate: { ci: { passed: boolean } } }>(
      aliceToken,
      "GET",
      `/api/repos/acme/core/prs/${prNum}/gate`,
    );
    expect(gateBefore.data.gate.ci.passed).toBe(true);

    // Push commit 2 — stale CI MUST be cleared
    await fs.writeFile(path.join(work, "stale.ts"), "export const a = 2; // broken\n");
    await git(work, ["commit", "-am", "commit 2"]);
    await git(work, ["push", "origin", "agent/stale-ci"]);

    const gateAfter = await api<{ gate: { ci: { passed: boolean; checks: unknown[] } } }>(
      aliceToken,
      "GET",
      `/api/repos/acme/core/prs/${prNum}/gate`,
    );
    expect(gateAfter.data.gate.ci.checks).toEqual([]);
    expect(gateAfter.data.gate.ci.passed).toBe(false);
  });

  it("does NOT mutate PR headSha or clear CI when upstream rejects a git-receive-pack push", async () => {
    const work = path.join(tmpRoot, "work-upstream-reject");
    const url = agitUrl.replace("http://", `http://coder-bot:${coderToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Coder"]);
    await git(work, ["config", "user.email", "coder@acme.dev"]);
    await git(work, ["checkout", "-b", "agent/upstream-reject"]);
    await fs.writeFile(path.join(work, "hook.ts"), "v1\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "v1"]);
    await git(work, ["push", "-u", "origin", "agent/upstream-reject"]);

    const created = await api<{ pr: { number: number; headSha: string } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "Upstream reject test", sourceBranch: "agent/upstream-reject" },
    );
    const prNum = created.data.pr.number;
    const validHeadSha = created.data.pr.headSha;
    await api(adminToken, "POST", `/api/repos/acme/core/prs/${prNum}/ci`, {
      checks: [{ name: "ci/test", status: "passed", updatedAt: new Date().toISOString() }],
    });

    // Install an upstream pre-receive hook that rejects pushes to agent/upstream-reject (like GitHub secret scanning / rulesets)
    const hookPath = path.join(bareRepoPath, "hooks", "pre-receive");
    await fs.writeFile(
      hookPath,
      "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = \"refs/heads/agent/upstream-reject\" ]; then\n    echo \"upstream secret scan rejected\" >&2\n    exit 1\n  fi\ndone\n",
      { mode: 0o755 },
    );

    try {
      await fs.writeFile(path.join(work, "hook.ts"), "v2_secret\n");
      await git(work, ["commit", "-am", "v2"]);
      await expect(git(work, ["push", "origin", "agent/upstream-reject"])).rejects.toThrow();

      const after = await api<{ pr: { headSha: string; ciChecks: unknown[] } }>(
        aliceToken,
        "GET",
        `/api/repos/acme/core/prs/${prNum}`,
      );
      expect(after.data.pr.headSha).toBe(validHeadSha);
      expect(after.data.pr.ciChecks).toHaveLength(1);
    } finally {
      await fs.rm(hookPath, { force: true });
    }
  });

  it("rejects PR self-approval with 403 and blocks PR author / agents from unilaterally resolving human blocking comments", async () => {
    const work = path.join(tmpRoot, "work-perms");
    const url = agitUrl.replace("http://", `http://coder-bot:${coderToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Coder"]);
    await git(work, ["config", "user.email", "coder@acme.dev"]);
    await git(work, ["checkout", "-b", "agent/perms-test"]);
    await fs.writeFile(path.join(work, "perms.ts"), "export const ok = true;\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "perms"]);
    await git(work, ["push", "-u", "origin", "agent/perms-test"]);

    const created = await api<{ pr: { number: number } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "Perms test", sourceBranch: "agent/perms-test" },
    );
    const prNum = created.data.pr.number;

    // Self-approval MUST fail with 403
    const selfReview = await api<{ error: string }>(
      coderToken,
      "POST",
      `/api/repos/acme/core/prs/${prNum}/reviews`,
      { status: "approved", body: "I approve myself" },
    );
    expect(selfReview.status).toBe(403);
    expect(selfReview.data.error).toMatch(/cannot approve their own/i);

    // Human Alice posts a blocking comment
    const cmt = await api<{ comment: { id: string } }>(
      aliceToken,
      "POST",
      `/api/repos/acme/core/prs/${prNum}/comments`,
      { commentType: "blocking", body: "Fix auth check" },
    );
    expect(cmt.status).toBe(201);

    // PR author (coder-bot) CANNOT resolve Alice's blocking comment
    const coderResolve = await api<{ error: string }>(
      coderToken,
      "POST",
      `/api/comments/${cmt.data.comment.id}/resolve`,
    );
    expect(coderResolve.status).toBe(403);

    // Another agent (review-bot) ALSO cannot resolve a human's blocking comment
    const botResolve = await api<{ error: string }>(
      reviewerToken,
      "POST",
      `/api/comments/${cmt.data.comment.id}/resolve`,
    );
    expect(botResolve.status).toBe(403);

    // Human author Alice CAN resolve her own blocking comment
    const aliceResolve = await api<{ comment: { resolved: boolean } }>(
      aliceToken,
      "POST",
      `/api/comments/${cmt.data.comment.id}/resolve`,
    );
    expect(aliceResolve.status).toBe(200);
    expect(aliceResolve.data.comment.resolved).toBe(true);
  });

  it("prevents duplicate open PRs for the same branch and supports closing PRs", async () => {
    const work = path.join(tmpRoot, "work-dup-close");
    const url = agitUrl.replace("http://", `http://coder-bot:${coderToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Coder"]);
    await git(work, ["config", "user.email", "coder@acme.dev"]);
    await git(work, ["checkout", "-b", "agent/dup-close"]);
    await fs.writeFile(path.join(work, "dup.ts"), "1\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "dup"]);
    await git(work, ["push", "-u", "origin", "agent/dup-close"]);

    const first = await api<{ pr: { number: number } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "First PR", sourceBranch: "agent/dup-close" },
    );
    expect(first.status).toBe(201);

    const dup = await api<{ error: string; existingPr?: { number: number } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "Duplicate PR", sourceBranch: "agent/dup-close" },
    );
    expect(dup.status).toBe(409);
    expect(dup.data.existingPr?.number).toBe(first.data.pr.number);

    // Close the first PR
    const closed = await api<{ pr: { status: string } }>(
      aliceToken,
      "POST",
      `/api/repos/acme/core/prs/${first.data.pr.number}/close`,
    );
    expect(closed.status).toBe(200);
    expect(closed.data.pr.status).toBe("closed");

    // Now opening a fresh PR for the same branch succeeds
    const reopened = await api<{ pr: { number: number } }>(
      coderToken,
      "POST",
      "/api/repos/acme/core/prs",
      { title: "Fresh PR after close", sourceBranch: "agent/dup-close" },
    );
    expect(reopened.status).toBe(201);
  });

  it("returns 409 Conflict with conflictingFiles on merge conflicts and invalidates diff cache when main moves", async () => {
    const work = path.join(tmpRoot, "work-conflict");
    const url = agitUrl.replace("http://", `http://alice:${aliceToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Alice"]);
    await git(work, ["config", "user.email", "alice@acme.dev"]);

    // Branch 1 edits conflict.txt
    await git(work, ["checkout", "-b", "feat/c1"]);
    await fs.writeFile(path.join(work, "conflict.txt"), "from branch 1\n");
    await git(work, ["commit", "-am", "c1"]);
    await git(work, ["push", "-u", "origin", "feat/c1"]);

    // Branch 2 edits conflict.txt AND extra.txt from same base
    await git(work, ["checkout", "-b", "feat/c2", "main"]);
    await fs.writeFile(path.join(work, "conflict.txt"), "from branch 2\n");
    await git(work, ["commit", "-am", "c2"]);
    await git(work, ["push", "-u", "origin", "feat/c2"]);

    const pr1 = (
      await api<{ pr: { number: number } }>(aliceToken, "POST", "/api/repos/acme/core/prs", {
        title: "Conflict PR 1",
        sourceBranch: "feat/c1",
      })
    ).data.pr;
    const pr2 = (
      await api<{ pr: { number: number } }>(aliceToken, "POST", "/api/repos/acme/core/prs", {
        title: "Conflict PR 2",
        sourceBranch: "feat/c2",
      })
    ).data.pr;

    // Prime diff cache for PR 2 before main moves
    await api(aliceToken, "GET", `/api/repos/acme/core/prs/${pr2.number}/diff`);

    // Approve & pass CI for both PRs (by admin so not self-approval)
    for (const num of [pr1.number, pr2.number]) {
      await api(adminToken, "POST", `/api/repos/acme/core/prs/${num}/ci`, {
        checks: [{ name: "ci/test", status: "passed", updatedAt: new Date().toISOString() }],
      });
      await api(adminToken, "POST", `/api/repos/acme/core/prs/${num}/reviews`, {
        status: "approved",
      });
    }

    // Merge PR 1 cleanly
    const m1 = await api<{ mergedSha: string }>(
      aliceToken,
      "POST",
      `/api/repos/acme/core/prs/${pr1.number}/merge`,
    );
    expect(m1.status).toBe(200);

    // Merging conflicting PR 2 MUST return 409 Conflict with conflictingFiles
    const m2 = await api<{ error: string; conflictingFiles?: string[] }>(
      aliceToken,
      "POST",
      `/api/repos/acme/core/prs/${pr2.number}/merge`,
    );
    expect(m2.status).toBe(409);
    expect(m2.data.conflictingFiles).toContain("conflict.txt");

    // Trying to close already-merged PR 1 MUST return 409
    const closeMerged = await api<{ error: string }>(
      aliceToken,
      "POST",
      `/api/repos/acme/core/prs/${pr1.number}/close`,
    );
    expect(closeMerged.status).toBe(409);
  });

  it("invalidates diff cache when the target branch advances", async () => {
    const work = path.join(tmpRoot, "work-diff-cache");
    const url = agitUrl.replace("http://", `http://alice:${aliceToken}@`) + "/git/acme/core.git";
    await git(tmpRoot, ["clone", url, work]);
    await git(work, ["config", "user.name", "Alice"]);
    await git(work, ["config", "user.email", "alice@acme.dev"]);

    // Create a shared file on feat/dc-base and feat/dc-child
    await git(work, ["checkout", "-b", "feat/dc-first"]);
    await fs.writeFile(path.join(work, "shared-cache.txt"), "hello\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "add shared-cache"]);
    await git(work, ["push", "-u", "origin", "feat/dc-first"]);

    // Second branch contains the exact same commit PLUS a second file
    await git(work, ["checkout", "-b", "feat/dc-second"]);
    await fs.writeFile(path.join(work, "only-second.txt"), "second\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "add only-second"]);
    await git(work, ["push", "-u", "origin", "feat/dc-second"]);

    const prFirst = (
      await api<{ pr: { number: number } }>(aliceToken, "POST", "/api/repos/acme/core/prs", {
        title: "DC First",
        sourceBranch: "feat/dc-first",
      })
    ).data.pr;
    const prSecond = (
      await api<{ pr: { number: number } }>(aliceToken, "POST", "/api/repos/acme/core/prs", {
        title: "DC Second",
        sourceBranch: "feat/dc-second",
      })
    ).data.pr;

    // Before prFirst merges, prSecond diff includes BOTH shared-cache.txt and only-second.txt
    const diffBefore = await api<{ visibleFiles: Array<{ path: string }> }>(
      aliceToken,
      "GET",
      `/api/repos/acme/core/prs/${prSecond.number}/diff`,
    );
    expect(diffBefore.data.visibleFiles.map((f) => f.path).sort()).toEqual([
      "only-second.txt",
      "shared-cache.txt",
    ]);

    // Merge prFirst into main (merge commit so merge-base for prSecond advances)
    await api(adminToken, "POST", `/api/repos/acme/core/prs/${prFirst.number}/ci`, {
      checks: [{ name: "ci/test", status: "passed", updatedAt: new Date().toISOString() }],
    });
    await api(adminToken, "POST", `/api/repos/acme/core/prs/${prFirst.number}/reviews`, {
      status: "approved",
    });
    const mergeFirst = await api(aliceToken, "POST", `/api/repos/acme/core/prs/${prFirst.number}/merge`, {
      mergeMethod: "merge",
    });
    expect(mergeFirst.status).toBe(200);

    // After main advances, prSecond diff MUST recompute and only show only-second.txt
    const diffAfter = await api<{ visibleFiles: Array<{ path: string }> }>(
      aliceToken,
      "GET",
      `/api/repos/acme/core/prs/${prSecond.number}/diff`,
    );
    expect(diffAfter.data.visibleFiles.map((f) => f.path)).toEqual(["only-second.txt"]);
  });

  it("verifies incoming GitHub and GitLab webhook signatures and rejects forged CI updates", async () => {
    // Register a GitHub repo WITH incomingWebhookSecret and a GitLab repo WITH incomingWebhookSecret
    const ghSecret = "gh_wh_secret_123";
    const glSecret = "gl_wh_secret_456";
    const ghRepo = await api(adminToken, "POST", "/api/repos", {
      slug: "acme/gh-wh",
      forgeType: "github",
      forgeBaseUrl: "https://api.github.com",
      upstreamRepo: "acme/gh-wh",
      upstreamGitUrl: "https://github.com/acme/gh-wh.git",
      upstreamToken: "ghp_fake",
      incomingWebhookSecret: ghSecret,
    });
    expect(ghRepo.status).toBe(201);

    const glRepo = await api(adminToken, "POST", "/api/repos", {
      slug: "acme/gl-wh",
      forgeType: "gitlab",
      forgeBaseUrl: "https://gitlab.com",
      upstreamRepo: "acme/gl-wh",
      upstreamGitUrl: "https://gitlab.com/acme/gl-wh.git",
      upstreamToken: "glpat_fake",
      incomingWebhookSecret: glSecret,
    });
    expect(glRepo.status).toBe(201);

    // Repo without webhook secret
    await api(adminToken, "POST", "/api/repos", {
      slug: "acme/gh-nosecret",
      forgeType: "github",
      forgeBaseUrl: "https://api.github.com",
      upstreamRepo: "acme/gh-nosecret",
      upstreamGitUrl: "https://github.com/acme/gh-nosecret.git",
      upstreamToken: "ghp_fake",
    });

    const ghBody = JSON.stringify({
      repository: { full_name: "acme/gh-wh" },
      check_run: { name: "ci", status: "completed", conclusion: "success", head_sha: "abc123" },
    });

    // 1. Missing signature -> 401
    const noSig = await api(null, "POST", "/api/incoming-webhooks/github", ghBody, {
      "X-GitHub-Event": "check_run",
    });
    expect(noSig.status).toBe(401);

    // 2. Wrong signature -> 401
    const badSig = await api(null, "POST", "/api/incoming-webhooks/github", ghBody, {
      "X-GitHub-Event": "check_run",
      "X-Hub-Signature-256": "sha256=0000",
    });
    expect(badSig.status).toBe(401);

    // 3. Valid signature -> 200
    const goodSig = await api<{ ok: boolean }>(
      null,
      "POST",
      "/api/incoming-webhooks/github",
      ghBody,
      {
        "X-GitHub-Event": "check_run",
        "X-Hub-Signature-256": signWebhookPayload(ghSecret, ghBody),
      },
    );
    expect(goodSig.status).toBe(200);
    expect(goodSig.data.ok).toBe(true);

    // 4. Repo with NO secret configured -> 401 (never accept unauthenticated webhooks)
    const noSecretRepoBody = JSON.stringify({
      repository: { full_name: "acme/gh-nosecret" },
      check_run: { name: "ci", status: "completed", conclusion: "success", head_sha: "abc123" },
    });
    const unconfiguredRes = await api(null, "POST", "/api/incoming-webhooks/github", noSecretRepoBody, {
      "X-GitHub-Event": "check_run",
    });
    expect(unconfiguredRes.status).toBe(401);

    // 5. GitLab missing/wrong token -> 401; valid token -> 200
    const glBody = JSON.stringify({
      object_kind: "pipeline",
      project: { path_with_namespace: "acme/gl-wh" },
      object_attributes: { id: 1, sha: "abc123", status: "success" },
    });
    const glBad = await api(null, "POST", "/api/incoming-webhooks/gitlab", glBody, {
      "X-Gitlab-Token": "wrong",
    });
    expect(glBad.status).toBe(401);

    const glGood = await api<{ ok: boolean }>(
      null,
      "POST",
      "/api/incoming-webhooks/gitlab",
      glBody,
      { "X-Gitlab-Token": glSecret },
    );
    expect(glGood.status).toBe(200);
    expect(glGood.data.ok).toBe(true);
  });

  it("attributes incoming-webhook auto-merge to a merge-capable actor rather than an unprivileged agent author", async () => {
    const ghSecret = "whsec_automerge";
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pulls") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            number: 99,
            html_url: "https://github.com/acme/auto/pull/99",
            head: { sha: "sha_auto_1" },
          }),
          { status: 201 },
        );
      }
      if (url.includes("/pulls/99/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ sha: "sha_merged_99" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const { GitHubForgeAdapter, ForgeRegistry } = await import("./forges/index.js");
    const forges = new ForgeRegistry({
      github: new GitHubForgeAdapter(mockFetch as unknown as typeof fetch),
    });

    const ctx = createApp({ dbPath: ":memory:", forges });
    const adminActor = ctx.store.getActorByHandle("admin")!;
    const coder = ctx.store.createActor({
      handle: "unpriv-agent",
      displayName: "Unprivileged Agent",
      type: "agent",
      role: "agent",
      canMerge: false,
      canApprove: false,
    });
    const reviewer = ctx.store.createActor({
      handle: "human-rev",
      displayName: "Human Reviewer",
      type: "human",
      role: "maintainer",
      canMerge: true,
      canApprove: true,
    });

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "acme/auto",
        forgeType: "github",
        forgeBaseUrl: "https://api.github.com",
        upstreamRepo: "acme/auto",
        upstreamGitUrl: "https://github.com/acme/auto.git",
        upstreamToken: "ghp_service",
        incomingWebhookSecret: ghSecret,
        mergePolicy: { requireCiPassed: true, requiredChecks: ["ci"], minApprovals: 1, defaultAutoMerge: true },
      }),
    });

    const prRes = await ctx.app.request("/api/repos/acme/auto/prs", {
      method: "POST",
      headers: { Authorization: `Bearer ${coder.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Auto merge via webhook",
        sourceBranch: "agent/auto",
        headSha: "sha_auto_1",
        autoMerge: true,
      }),
    });
    expect(prRes.status).toBe(201);

    // Human reviewer approves
    const revRes = await ctx.app.request("/api/repos/acme/auto/prs/1/reviews", {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", body: "LGTM" }),
    });
    expect(revRes.status).toBe(201);

    // Signed GitHub CI webhook arrives -> triggers auto-merge
    const payload = JSON.stringify({
      repository: { full_name: "acme/auto" },
      check_run: { name: "ci", status: "completed", conclusion: "success", head_sha: "sha_auto_1" },
    });
    const whRes = await ctx.app.request("/api/incoming-webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "check_run",
        "X-Hub-Signature-256": signWebhookPayload(ghSecret, payload),
      },
      body: payload,
    });
    expect(whRes.status).toBe(200);

    const finalPr = (await (await ctx.app.request("/api/repos/acme/auto/prs/1", {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    })).json()) as { pr: { status: string; mergedByActorId: string | null } };
    expect(finalPr.pr.status).toBe("merged");
    expect(finalPr.pr.mergedByActorId).toBe(adminActor.id);
    expect(finalPr.pr.mergedByActorId).not.toBe(coder.actor.id);
  });
});
