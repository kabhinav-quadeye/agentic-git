import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ForgeRegistry, GitHubForgeAdapter } from "./forges/index.js";
import { signWebhookPayload } from "./webhooks.js";

describe("Phase 2 — Bidirectional GitHub sync, canonical PR numbers, and CRUD", () => {
  it("adopts upstream GitHub PR number as canonical pr.number when creating a PR", async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            number: 483,
            html_url: "https://github.com/acme/web/pull/483",
            head: { sha: "sha_483" },
          }),
          { status: 201 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const forges = new ForgeRegistry({
      github: new GitHubForgeAdapter(mockFetch as unknown as typeof fetch),
    });
    const ctx = createApp({ dbPath: ":memory:", forges });

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "acme/web",
        forgeType: "github",
        forgeBaseUrl: "https://api.github.com",
        upstreamRepo: "acme/web",
        upstreamGitUrl: "https://github.com/acme/web.git",
        upstreamToken: "ghp_tok",
      }),
    });

    const res = await ctx.app.request("/api/repos/acme/web/prs", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Use upstream PR number",
        sourceBranch: "feat/num",
        headSha: "sha_483",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { pr: { number: number; upstreamPrId: string } };
    expect(data.pr.number).toBe(483);
    expect(data.pr.upstreamPrId).toBe("483");
  });

  it("imports existing open GitHub PRs and checks via POST /api/repos/:org/:repo/sync", async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls?state=open")) {
        return new Response(
          JSON.stringify([
            {
              number: 101,
              title: "Existing GitHub PR",
              body: "Opened before migrating",
              html_url: "https://github.com/acme/migrated/pull/101",
              head: { ref: "feat/existing", sha: "sha_101" },
              base: { ref: "main" },
              user: { login: "teammate" },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/commits/sha_101/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ name: "ci/build", status: "completed", conclusion: "success" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/commits/sha_101/status")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const forges = new ForgeRegistry({
      github: new GitHubForgeAdapter(mockFetch as unknown as typeof fetch),
    });
    const ctx = createApp({ dbPath: ":memory:", forges });

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "acme/migrated",
        forgeType: "github",
        forgeBaseUrl: "https://api.github.com",
        upstreamRepo: "acme/migrated",
        upstreamGitUrl: "https://github.com/acme/migrated.git",
        upstreamToken: "ghp_tok",
      }),
    });

    const syncRes = await ctx.app.request("/api/repos/acme/migrated/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(syncRes.status).toBe(200);
    const syncData = (await syncRes.json()) as {
      imported: number;
      updated: number;
      prs: Array<{ number: number; title: string; ciChecks: Array<{ name: string; status: string }> }>;
    };
    expect(syncData.imported).toBe(1);
    expect(syncData.prs[0].number).toBe(101);
    expect(syncData.prs[0].title).toBe("Existing GitHub PR");
    expect(syncData.prs[0].ciChecks[0]).toMatchObject({ name: "ci/build", status: "passed" });

    // Re-running sync is idempotent (updates instead of duplicating)
    const syncRes2 = await ctx.app.request("/api/repos/acme/migrated/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    const syncData2 = (await syncRes2.json()) as { imported: number; updated: number };
    expect(syncData2.imported).toBe(0);
    expect(syncData2.updated).toBe(1);
  });

  it("syncs GitHub pull_request and pull_request_review webhooks from teammates still on github.com", async () => {
    const secret = "whsec_bidi";
    const ctx = createApp({ dbPath: ":memory:" });

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "acme/team",
        forgeType: "github",
        forgeBaseUrl: "https://api.github.com",
        upstreamRepo: "acme/team",
        upstreamGitUrl: "https://github.com/acme/team.git",
        upstreamToken: "ghp_tok",
        incomingWebhookSecret: secret,
        mergePolicy: { requireCiPassed: false, minApprovals: 1 },
      }),
    });

    // 1. Teammate opens PR #55 directly on github.com
    const openPayload = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/team" },
      pull_request: {
        number: 55,
        title: "Teammate PR from github.com",
        body: "Hello from web",
        html_url: "https://github.com/acme/team/pull/55",
        head: { ref: "feat/gh-web", sha: "sha_55_v1" },
        base: { ref: "main" },
        user: { login: "bob" },
      },
    });
    const openRes = await ctx.app.request("/api/incoming-webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": signWebhookPayload(secret, openPayload),
      },
      body: openPayload,
    });
    expect(openRes.status).toBe(200);

    const prAfterOpen = (await (
      await ctx.app.request("/api/repos/acme/team/prs/55", {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
      })
    ).json()) as { pr: { number: number; headSha: string; title: string } };
    expect(prAfterOpen.pr.number).toBe(55);
    expect(prAfterOpen.pr.headSha).toBe("sha_55_v1");

    // 2. Teammate pushes directly to github.com -> pull_request synchronize updates headSha
    const syncPayload = JSON.stringify({
      action: "synchronize",
      repository: { full_name: "acme/team" },
      pull_request: {
        number: 55,
        title: "Teammate PR from github.com",
        body: "Hello from web",
        html_url: "https://github.com/acme/team/pull/55",
        head: { ref: "feat/gh-web", sha: "sha_55_v2" },
        base: { ref: "main" },
        user: { login: "bob" },
      },
    });
    await ctx.app.request("/api/incoming-webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": signWebhookPayload(secret, syncPayload),
      },
      body: syncPayload,
    });

    // 3. Another teammate approves on github.com -> pull_request_review synced!
    const reviewPayload = JSON.stringify({
      action: "submitted",
      repository: { full_name: "acme/team" },
      pull_request: { number: 55, head: { sha: "sha_55_v2" } },
      review: {
        state: "approved",
        body: "Looks great from GitHub UI",
        commit_id: "sha_55_v2",
        user: { login: "carol" },
      },
    });
    const revRes = await ctx.app.request("/api/incoming-webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review",
        "X-Hub-Signature-256": signWebhookPayload(secret, reviewPayload),
      },
      body: reviewPayload,
    });
    expect(revRes.status).toBe(200);

    const detail = (await (
      await ctx.app.request("/api/repos/acme/team/prs/55", {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
      })
    ).json()) as {
      pr: { headSha: string };
      reviews: Array<{ actorHandle: string; status: string }>;
      gate: { canMerge: boolean; approvals: { approvedHandles: string[] } };
    };
    expect(detail.pr.headSha).toBe("sha_55_v2");
    expect(detail.reviews.some((r) => r.actorHandle === "carol" && r.status === "approved")).toBe(true);
    expect(detail.gate.canMerge).toBe(true);
  });

  it("supports PR reopen and DELETE endpoints for webhooks, actors, and repos", async () => {
    const ctx = createApp({ dbPath: ":memory:" });
    const hdr = { Authorization: `Bearer ${ctx.adminToken}`, "Content-Type": "application/json" };

    await ctx.app.request("/api/repos", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        slug: "acme/crud",
        forgeType: "local",
        forgeBaseUrl: "local://upstream",
        upstreamRepo: "/tmp/unused",
        upstreamGitUrl: "/tmp/unused",
      }),
    });

    // Create & delete webhook
    const wh = (await (
      await ctx.app.request("/api/repos/acme/crud/webhooks", {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ url: "https://example.test/hook", events: ["pr.opened"] }),
      })
    ).json()) as { webhook: { id: string } };
    const delWh = await ctx.app.request(`/api/repos/acme/crud/webhooks/${wh.webhook.id}`, {
      method: "DELETE",
      headers: hdr,
    });
    expect(delWh.status).toBe(200);

    // Create & revoke agent actor
    const bot = (await (
      await ctx.app.request("/api/actors", {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ handle: "temp-bot", displayName: "Temp", type: "agent", role: "agent" }),
      })
    ).json()) as { actor: { id: string }; token: string };
    const delBot = await ctx.app.request(`/api/actors/${bot.actor.id}`, {
      method: "DELETE",
      headers: hdr,
    });
    expect(delBot.status).toBe(200);
    const botMe = await ctx.app.request("/api/me", {
      headers: { Authorization: `Bearer ${bot.token}` },
    });
    expect(botMe.status).toBe(401);

    // Close & reopen PR
    const pr = (await (
      await ctx.app.request("/api/repos/acme/crud/prs", {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ title: "Reopen me", sourceBranch: "feat/r", headSha: "sha_r" }),
      })
    ).json()) as { pr: { number: number } };
    await ctx.app.request(`/api/repos/acme/crud/prs/${pr.pr.number}/close`, { method: "POST", headers: hdr });
    const reopen = await ctx.app.request(`/api/repos/acme/crud/prs/${pr.pr.number}/reopen`, {
      method: "POST",
      headers: hdr,
    });
    expect(reopen.status).toBe(200);
    expect(((await reopen.json()) as { pr: { status: string } }).pr.status).toBe("open");

    // Delete repo
    const delRepo = await ctx.app.request("/api/repos/acme/crud", { method: "DELETE", headers: hdr });
    expect(delRepo.status).toBe(200);
    const getDeleted = await ctx.app.request("/api/repos/acme/crud", { headers: hdr });
    expect(getDeleted.status).toBe(404);
  });
});
