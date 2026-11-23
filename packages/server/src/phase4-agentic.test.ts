import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("Phase 4 — Diff-filter presets, verified SHA badges, deferred follow-ups, and fix-blocking loop", () => {
  let hookServer: http.Server;
  let hookUrl: string;
  const receivedHooks: Array<{ event: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    hookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        receivedHooks.push({
          event: String(req.headers["x-agentic-git-event"] ?? ""),
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
    const addr = hookServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    hookUrl = `http://127.0.0.1:${port}/agent`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });

  it("lists diff-filter presets, applies a preset to a repo, and exposes approvedAtSha on hidden files", async () => {
    const ctx = createApp({ dbPath: ":memory:" });
    const hdr = { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" };

    // List presets
    const presetsRes = await ctx.app.request("/api/presets/diff-filters", { headers: hdr });
    expect(presetsRes.status).toBe(200);
    const presetsData = (await presetsRes.json()) as { presets: Array<{ id: string }> };
    expect(presetsData.presets.map((p) => p.id)).toContain("hide-lockfiles");
    expect(presetsData.presets.map((p) => p.id)).toContain("hide-tests-after-agent");

    // Create repo and apply preset
    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        slug: "acme/p4",
        forgeType: "local",
        forgeBaseUrl: "local://upstream",
        upstreamRepo: "/tmp/unused",
        upstreamGitUrl: "/tmp/unused",
      }),
    });

    const applyRes = await ctx.app.request("/api/repos/acme/p4/presets/diff-filters", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ presetId: "hide-tests-after-agent", agentHandle: "qa-bot" }),
    });
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as {
      repo: { diffFilterRules: Array<{ id: string; whenAgentApproved?: string | null }> };
    };
    expect(applied.repo.diffFilterRules).toHaveLength(1);
    expect(applied.repo.diffFilterRules[0].whenAgentApproved).toBe("qa-bot");

    // Verify approvedAtSha is populated when filterDiffFiles hides a file
    const { filterDiffFiles } = await import("./policy-engine.js");
    const repoInternal = ctx.store.getRepoBySlug("acme/p4")!;
    const filtered = filterDiffFiles({
      pr: {
        id: "pr_1",
        number: 1,
        repoId: repoInternal.id,
        repoSlug: "acme/p4",
        title: "Test",
        description: "",
        sourceBranch: "feat/x",
        targetBranch: "main",
        headSha: "deadbeef1234",
        status: "open",
        authorActorId: "a1",
        authorHandle: "coder",
        authorType: "agent",
        upstreamPrId: null,
        upstreamPrUrl: null,
        autoMerge: false,
        assignedAgents: ["qa-bot"],
        ciChecks: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      files: [{ path: "src/app.test.ts", status: "modified", additions: 10, deletions: 2, patch: "+x" }],
      rules: repoInternal.diffFilterRules,
      viewer: { handle: "alice", type: "human" },
      reviews: [
        {
          id: "rev_1",
          prId: "pr_1",
          actorId: "a_qa",
          actorHandle: "qa-bot",
          actorType: "agent",
          status: "approved",
          body: "LGTM",
          commitSha: "deadbeef1234",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(filtered.hiddenFiles).toHaveLength(1);
    expect(filtered.hiddenFiles[0].approvedAtSha).toBe("deadbeef1234");
  });

  it("extracts actionable defer_to_next_pr follow-ups and dispatches bundled fix-blocking requests to an agent", async () => {
    const ctx = createApp({ dbPath: ":memory:" });
    const hdr = { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" };

    // Register agent bot with direct webhook URL
    await ctx.app.request("/api/actors", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        handle: "fixer-bot",
        displayName: "Fixer Bot",
        type: "agent",
        role: "agent",
        agentWebhookUrl: hookUrl,
      }),
    });

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        slug: "acme/loop",
        forgeType: "local",
        forgeBaseUrl: "local://upstream",
        upstreamRepo: "/tmp/unused",
        upstreamGitUrl: "/tmp/unused",
      }),
    });

    const prRes = await ctx.app.request("/api/repos/acme/loop/prs", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ title: "Billing refactor", sourceBranch: "feat/bill", headSha: "sha_bill" }),
    });
    const pr = ((await prRes.json()) as { pr: { number: number } }).pr;

    // Post 1 blocking comment, 1 error finding, 1 failing CI check, and 2 defer_to_next_pr comments
    await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/comments`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        commentType: "blocking",
        body: "Handle negative amounts",
        filePath: "src/charge.ts",
        line: 12,
      }),
    });
    await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/comments`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        commentType: "agent_finding",
        severity: "error",
        body: "Unhandled promise rejection",
        filePath: "src/charge.ts",
        line: 24,
      }),
    });
    await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/comments`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        commentType: "defer_to_next_pr",
        body: "Extract currency formatter helper",
        filePath: "src/charge.ts",
        line: 5,
      }),
    });
    await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/ci`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        checks: [{ name: "ci/unit", status: "failed", summary: "2 tests failed", updatedAt: new Date().toISOString() }],
      }),
    });

    // 1. Follow-ups endpoint
    const fuRes = await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/followups`, {
      headers: hdr,
    });
    expect(fuRes.status).toBe(200);
    const fu = (await fuRes.json()) as {
      items: Array<{ body: string; filePath: string | null }>;
      markdown: string;
    };
    expect(fu.items).toHaveLength(1);
    expect(fu.items[0].body).toBe("Extract currency formatter helper");
    expect(fu.markdown).toContain("- [ ]");
    expect(fu.markdown).toContain("src/charge.ts:5");

    // Repo-wide follow-ups
    const repoFu = await ctx.app.request("/api/repos/acme/loop/followups", { headers: hdr });
    expect(repoFu.status).toBe(200);
    expect(((await repoFu.json()) as { items: unknown[] }).items).toHaveLength(1);

    // 2. Fix-blocking endpoint bundles blocking comments + error findings + failing CI and invokes agent
    const fixRes = await ctx.app.request(`/api/repos/acme/loop/prs/${pr.number}/fix-blocking`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ agentHandle: "fixer-bot" }),
    });
    expect(fixRes.status).toBe(202);
    const fixData = (await fixRes.json()) as {
      ok: boolean;
      bundle: {
        blockingComments: unknown[];
        errorFindings: unknown[];
        failingChecks: unknown[];
      };
      deliveries: unknown[];
    };
    expect(fixData.bundle.blockingComments).toHaveLength(1);
    expect(fixData.bundle.errorFindings).toHaveLength(1);
    expect(fixData.bundle.failingChecks).toHaveLength(1);
    expect(fixData.deliveries).toHaveLength(1);
    expect(receivedHooks.some((h) => h.event === "agent.invoked" && h.body.targetAgentHandle === "fixer-bot")).toBe(true);
  });
});
