import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
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

describe("End-to-end Git Smart-HTTP proxy + Shadow PR + Typed Comments + Diff Filtering + Auto-Merge", () => {
  let tmpRoot: string;
  let upstreamRoot: string;
  let bareRepoPath: string;
  let upstreamGitServer: Awaited<ReturnType<typeof startLocalGitHttpServer>>;
  let agitServer: ReturnType<typeof serve>;
  let agitUrl: string;
  let webhookServer: http.Server;
  let webhookUrl: string;
  const receivedWebhooks: Array<{
    event: string;
    signature: string;
    rawBody: string;
    body: Record<string, unknown>;
  }> = [];

  let adminToken: string;
  let aliceToken: string;
  let coderBotToken: string;
  let testReviewBotToken: string;
  let securityBotToken: string;

  async function api<T>(token: string, method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${agitUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agit-e2e-"));
    upstreamRoot = path.join(tmpRoot, "upstream");
    bareRepoPath = path.join(upstreamRoot, "demo", "calc.git");
    await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });

    // Initialize a real bare upstream git repository with an initial commit on main
    await git(tmpRoot, ["init", "--bare", "--initial-branch=main", bareRepoPath]);
    const seedDir = path.join(tmpRoot, "seed");
    await fs.mkdir(seedDir);
    await git(seedDir, ["init", "--initial-branch=main"]);
    await git(seedDir, ["config", "user.name", "Seed"]);
    await git(seedDir, ["config", "user.email", "seed@demo.local"]);
    await fs.writeFile(path.join(seedDir, "README.md"), "# Calc App\n");
    await git(seedDir, ["add", "."]);
    await git(seedDir, ["commit", "-m", "initial commit"]);
    await git(seedDir, ["remote", "add", "origin", bareRepoPath]);
    await git(seedDir, ["push", "-u", "origin", "main"]);

    // 1. Start real upstream Git Smart-HTTP server requiring Alice's upstream token
    upstreamGitServer = await startLocalGitHttpServer({
      projectRoot: upstreamRoot,
      requiredToken: "alice_upstream_pat_123",
    });

    // 2. Start external agentic-app webhook receiver
    webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        receivedWebhooks.push({
          event: String(req.headers["x-agentic-git-event"] ?? ""),
          signature: String(req.headers["x-agentic-git-signature"] ?? ""),
          rawBody,
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    const whAddr = webhookServer.address();
    const whPort = typeof whAddr === "object" && whAddr ? whAddr.port : 0;
    webhookUrl = `http://127.0.0.1:${whPort}/hooks`;

    // 3. Start agentic-git server
    const ctx = createApp({ dbPath: path.join(tmpRoot, "agit.db") });
    adminToken = ctx.adminToken;
    agitServer = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => agitServer.once("listening", resolve));
    const addr = agitServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    agitUrl = `http://127.0.0.1:${port}`;

    // 4. Create human owner Alice with her upstream token, and 3 distinct agent bots under Alice
    const aliceRes = await api<{ actor: { id: string }; token: string }>(adminToken, "POST", "/api/actors", {
      handle: "alice",
      displayName: "Alice Owner",
      type: "human",
      role: "maintainer",
      canMerge: true,
      canApprove: true,
      upstreamToken: "alice_upstream_pat_123",
    });
    expect(aliceRes.status).toBe(201);
    aliceToken = aliceRes.data.token;

    // Alice creates her own agent bots (no admin required!)
    const coderRes = await api<{ token: string }>(aliceToken, "POST", "/api/actors", {
      handle: "coder-agent",
      displayName: "Coder Bot",
      type: "agent",
      role: "agent",
      allowedBranchPatterns: ["agent/**"],
      canMerge: false,
      canApprove: false,
      agentWebhookUrl: webhookUrl,
    });
    coderBotToken = coderRes.data.token;

    const testRevRes = await api<{ token: string }>(aliceToken, "POST", "/api/actors", {
      handle: "test-review-agent",
      displayName: "Test Review Bot",
      type: "agent",
      role: "agent",
      allowedBranchPatterns: ["agent/**"],
      canMerge: false,
      canApprove: true,
    });
    testReviewBotToken = testRevRes.data.token;

    const secRevRes = await api<{ token: string }>(aliceToken, "POST", "/api/actors", {
      handle: "security-agent",
      displayName: "Security Review Bot",
      type: "agent",
      role: "agent",
      allowedBranchPatterns: ["agent/**"],
      canMerge: false,
      canApprove: true,
    });
    securityBotToken = secRevRes.data.token;

    // 5. Register repo in per_user credential mode (agents inherit owner Alice's upstream token!)
    const repoRes = await api(aliceToken, "POST", "/api/repos", {
      slug: "demo/calc",
      forgeType: "local",
      forgeBaseUrl: "local://upstream",
      upstreamRepo: bareRepoPath,
      upstreamGitUrl: `${upstreamGitServer.url}/demo/calc.git`,
      upstreamToken: "",
      defaultBranch: "main",
      credentialMode: "per_user",
      protectedBranches: ["main"],
      mergePolicy: {
        requireCiPassed: true,
        requiredChecks: ["unit-tests"],
        minApprovals: 2,
        requiredApprovers: ["test-review-agent", "security-agent"],
        blockOnErrorFindings: true,
        defaultAutoMerge: true,
      },
      diffFilterRules: [
        {
          id: "hide-tests-when-reviewed",
          name: "Hide tests approved by test-review-agent",
          description: "Human reviewers skip test files once test-review-agent approves",
          filePatterns: ["**/*.test.ts"],
          hideForActorTypes: ["human"],
          hideForHandles: [],
          whenAgentAssigned: "test-review-agent",
          whenAgentApproved: "test-review-agent",
          enabled: true,
        },
      ],
      customCommentTypes: [
        {
          key: "next_sprint",
          label: "Next Sprint",
          description: "Track for next sprint, non-blocking",
          blocksMerge: false,
          agentInstruction: "DO NOT implement now. Create a backlog note.",
          color: "#0ea5e9",
          builtin: false,
        },
      ],
    });
    expect(repoRes.status).toBe(201);

    // Register webhook subscription to our external agentic app
    await api(aliceToken, "POST", "/api/repos/demo/calc/webhooks", {
      url: webhookUrl,
      secret: "my_hmac_secret",
      events: ["pr.opened", "pr.updated", "comment.created", "comment.resolved", "review.submitted", "pr.merged", "agent.invoked"],
    });
  });

  afterAll(async () => {
    agitServer.close();
    await upstreamGitServer.close();
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("enforces git push permissions, tracks agent attribution, filters diffs, handles typed comments, and auto-merges", async () => {
    const workDir = path.join(tmpRoot, "agent-clone");
    const proxyUrlWithBotCreds = agitUrl.replace("http://", `http://coder-agent:${coderBotToken}@`) + "/git/demo/calc.git";

    // 1. Real `git clone` through agentic-git proxy using coder-agent's bot token
    await git(tmpRoot, ["clone", proxyUrlWithBotCreds, workDir]);
    await git(workDir, ["config", "user.name", "Coder Agent"]);
    await git(workDir, ["config", "user.email", "coder-agent@demo.local"]);

    // 2. Direct push to protected branch `main` MUST be rejected by agentic-git proxy
    await fs.writeFile(path.join(workDir, "illegal.txt"), "nope\n");
    await git(workDir, ["add", "illegal.txt"]);
    await git(workDir, ["commit", "-m", "try pushing directly to main"]);
    await expect(git(workDir, ["push", "origin", "main"])).rejects.toThrow(/protected branch 'main'/i);

    // Reset main back to origin/main and try pushing to unpermitted branch `release/v1`
    await git(workDir, ["reset", "--hard", "origin/main"]);
    await git(workDir, ["checkout", "-b", "release/v1"]);
    await fs.writeFile(path.join(workDir, "rel.txt"), "nope\n");
    await git(workDir, ["add", "rel.txt"]);
    await git(workDir, ["commit", "-m", "try release branch"]);
    await expect(git(workDir, ["push", "-u", "origin", "release/v1"])).rejects.toThrow(/only allowed to push branches matching/i);

    // 3. Push to allowed branch `agent/add-math` with source + test files
    await git(workDir, ["checkout", "main"]);
    await git(workDir, ["checkout", "-b", "agent/add-math"]);
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workDir, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
    await fs.writeFile(
      path.join(workDir, "src/math.test.ts"),
      "import { add } from './math';\nif (add(2, 3) !== 5) throw new Error('fail');\n",
    );
    await git(workDir, ["add", "."]);
    await git(workDir, ["commit", "-m", "feat: add math helper and tests"]);
    await git(workDir, ["push", "-u", "origin", "agent/add-math"]);

    // Verify push audit recorded both denials and the allowed push with exact owner attribution
    const pushesRes = await api<{ pushes: Array<{ actorHandle: string; ownerHandle: string; ref: string; allowed: boolean }> }>(
      aliceToken,
      "GET",
      "/api/repos/demo/calc/pushes",
    );
    expect(pushesRes.data.pushes.some((p) => p.actorHandle === "coder-agent" && p.ownerHandle === "alice" && p.ref === "refs/heads/main" && !p.allowed)).toBe(true);
    expect(pushesRes.data.pushes.some((p) => p.actorHandle === "coder-agent" && p.ownerHandle === "alice" && p.ref === "refs/heads/agent/add-math" && p.allowed)).toBe(true);

    // 4. coder-agent opens PR #1 with autoMerge=true & test-review-agent assigned
    const prRes = await api<{ pr: { number: number; headSha: string; upstreamPrId: string } }>(
      coderBotToken,
      "POST",
      "/api/repos/demo/calc/prs",
      {
        title: "Add math module",
        description: "Implements add() with unit test",
        sourceBranch: "agent/add-math",
        targetBranch: "main",
        autoMerge: true,
        assignedAgents: ["test-review-agent", "security-agent"],
      },
    );
    expect(prRes.status).toBe(201);
    expect(prRes.data.pr.number).toBe(1);
    expect(prRes.data.pr.upstreamPrId).toBeTruthy();

    // 5. Before test-review-agent approves, human Alice sees BOTH src/math.ts and src/math.test.ts
    const diffBefore = await api<{ visibleFiles: Array<{ path: string }>; hiddenFiles: unknown[] }>(
      aliceToken,
      "GET",
      "/api/repos/demo/calc/prs/1/diff",
    );
    expect(diffBefore.data.visibleFiles.map((f) => f.path).sort()).toEqual(["src/math.test.ts", "src/math.ts"]);
    expect(diffBefore.data.hiddenFiles).toHaveLength(0);

    // 6. test-review-agent approves PR #1
    const rev1 = await api<{ autoMerged: boolean }>(testReviewBotToken, "POST", "/api/repos/demo/calc/prs/1/reviews", {
      status: "approved",
      body: "Tests look solid",
    });
    expect(rev1.status).toBe(201);
    expect(rev1.data.autoMerged).toBe(false);

    // Now Alice's diff hides src/math.test.ts because test-review-agent approved!
    const diffAfter = await api<{ visibleFiles: Array<{ path: string }>; hiddenFiles: Array<{ path: string; coveredByAgent: string }> }>(
      aliceToken,
      "GET",
      "/api/repos/demo/calc/prs/1/diff",
    );
    expect(diffAfter.data.visibleFiles.map((f) => f.path)).toEqual(["src/math.ts"]);
    expect(diffAfter.data.hiddenFiles).toHaveLength(1);
    expect(diffAfter.data.hiddenFiles[0]).toMatchObject({
      path: "src/math.test.ts",
      coveredByAgent: "test-review-agent",
    });

    // 7. security-agent posts ONE blocking comment AND ONE defer_to_next_pr comment
    const blockingCmt = await api<{ comment: { id: string; commentTypeMeta: { blocksMerge: boolean; agentInstruction: string } } }>(
      securityBotToken,
      "POST",
      "/api/repos/demo/calc/prs/1/comments",
      {
        commentType: "blocking",
        body: "Guard against NaN inputs in add()",
        filePath: "src/math.ts",
        line: 1,
      },
    );
    expect(blockingCmt.status).toBe(201);
    expect(blockingCmt.data.comment.commentTypeMeta.blocksMerge).toBe(true);

    const deferCmt = await api<{ comment: { id: string; commentTypeMeta: { blocksMerge: boolean } } }>(
      securityBotToken,
      "POST",
      "/api/repos/demo/calc/prs/1/comments",
      {
        commentType: "defer_to_next_pr",
        body: "Add BigInt support in a future PR — do not implement now",
        filePath: "src/math.ts",
      },
    );
    expect(deferCmt.status).toBe(201);
    expect(deferCmt.data.comment.commentTypeMeta.blocksMerge).toBe(false);

    // Alice invokes coder-agent directly on the blocking comment via UI/API hook
    const invokeRes = await api<{ ok: boolean; deliveries: unknown[] }>(
      aliceToken,
      "POST",
      "/api/repos/demo/calc/prs/1/invoke-agent",
      {
        agentHandle: "coder-agent",
        commentId: blockingCmt.data.comment.id,
        prompt: "Fix the NaN guard requested by security-agent",
      },
    );
    expect(invokeRes.status).toBe(202);

    // Verify HMAC-signed webhooks arrived at our external agentic app
    const cmtHook = receivedWebhooks.find(
      (w) => w.event === "comment.created" && (w.body.comment as { id?: string })?.id === blockingCmt.data.comment.id,
    );
    expect(cmtHook).toBeDefined();
    expect(cmtHook!.signature).toBe(signWebhookPayload("my_hmac_secret", cmtHook!.rawBody));
    expect((cmtHook!.body.commentTypeDefinition as { blocksMerge?: boolean }).blocksMerge).toBe(true);

    const invokeHook = receivedWebhooks.find((w) => w.event === "agent.invoked");
    expect(invokeHook).toBeDefined();
    expect(invokeHook!.body.targetAgentHandle).toBe("coder-agent");

    // 8. coder-agent pushes fix commit, resolves ONLY the blocking comment (leaves defer_to_next_pr open!)
    await fs.writeFile(
      path.join(workDir, "src/math.ts"),
      "export const add = (a: number, b: number) => {\n  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('NaN');\n  return a + b;\n};\n",
    );
    await git(workDir, ["add", "src/math.ts"]);
    await git(workDir, ["commit", "-m", "fix: guard against NaN inputs"]);
    await git(workDir, ["push", "origin", "agent/add-math"]);

    // CI passes, security-agent approves — still blocked while blocking comment is unresolved!
    await api(aliceToken, "POST", "/api/repos/demo/calc/prs/1/ci", {
      checks: [{ name: "unit-tests", status: "passed", updatedAt: new Date().toISOString() }],
    });
    const rev2 = await api<{ autoMerged: boolean; gate: { canMerge: boolean; comments: { unresolvedBlockingIds: string[] } } }>(
      securityBotToken,
      "POST",
      "/api/repos/demo/calc/prs/1/reviews",
      { status: "approved", body: "Security review passed after fix" },
    );
    expect(rev2.data.autoMerged).toBe(false);
    expect(rev2.data.gate.canMerge).toBe(false);
    expect(rev2.data.gate.comments.unresolvedBlockingIds).toEqual([blockingCmt.data.comment.id]);

    // 9. PR author cannot unilaterally resolve reviewer's blocking comment; once security-agent resolves it, ALL gates pass -> AUTO-MERGES immediately even though defer_to_next_pr is unresolved!
    const deniedResolve = await api<{ error: string }>(
      coderBotToken,
      "POST",
      `/api/comments/${blockingCmt.data.comment.id}/resolve`,
    );
    expect(deniedResolve.status).toBe(403);

    const resolveRes = await api<{ autoMerged: boolean; mergedSha: string }>(
      securityBotToken,
      "POST",
      `/api/comments/${blockingCmt.data.comment.id}/resolve`,
    );
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.data.autoMerged).toBe(true);
    expect(resolveRes.data.mergedSha).toBeTruthy();

    // Verify PR status is merged AND the actual upstream bare git repo's `main` branch now contains src/math.ts!
    const finalPr = await api<{ pr: { status: string } }>(aliceToken, "GET", "/api/repos/demo/calc/prs/1");
    expect(finalPr.data.pr.status).toBe("merged");

    const { stdout: mainFiles } = await git(bareRepoPath, ["ls-tree", "-r", "--name-only", "refs/heads/main"]);
    expect(mainFiles).toContain("src/math.ts");
    expect(mainFiles).toContain("src/math.test.ts");
  });
});
