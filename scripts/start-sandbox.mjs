import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createApp, startLocalGitHttpServer } from "../packages/server/dist/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

const rootDir = process.argv[2] || "/tmp/agit-live-sandbox";
await fs.rm(rootDir, { recursive: true, force: true });
await fs.mkdir(rootDir, { recursive: true });

const upstreamRoot = path.join(rootDir, "upstream");
const bareRepoPath = path.join(upstreamRoot, "sandbox", "todo-lib.git");
await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });

// 1. Create a brand new starter project and push it to the upstream bare repo
await git(rootDir, ["init", "--bare", "--initial-branch=main", bareRepoPath]);
const seedDir = path.join(rootDir, "seed");
await fs.mkdir(path.join(seedDir, "src"), { recursive: true });
await fs.mkdir(path.join(seedDir, "test"), { recursive: true });
await git(seedDir, ["init", "--initial-branch=main"]);
await git(seedDir, ["config", "user.name", "Alice"]);
await git(seedDir, ["config", "user.email", "alice@sandbox.local"]);

await fs.writeFile(
  path.join(seedDir, "package.json"),
  JSON.stringify({ name: "todo-lib", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
);
await fs.writeFile(
  path.join(seedDir, "src/index.js"),
  `export function createTodo(title, priority = "medium") {\n  return { title, priority, done: false };\n}\n`,
);
await fs.writeFile(
  path.join(seedDir, "test/index.test.js"),
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { createTodo } from "../src/index.js";\n\ntest("createTodo sets defaults", () => {\n  const t = createTodo("ship agentic-git");\n  assert.equal(t.title, "ship agentic-git");\n  assert.equal(t.priority, "medium");\n  assert.equal(t.done, false);\n});\n`,
);
await git(seedDir, ["add", "."]);
await git(seedDir, ["commit", "-m", "chore: bootstrap todo-lib project"]);
await git(seedDir, ["remote", "add", "origin", bareRepoPath]);
await git(seedDir, ["push", "-u", "origin", "main"]);

// 2. Start real upstream Git Smart-HTTP server
const upstreamGit = await startLocalGitHttpServer({
  projectRoot: upstreamRoot,
  requiredToken: "alice_upstream_secret_token",
});

// 3. Start external agentic-app webhook receiver
const webhookLogPath = path.join(rootDir, "webhooks.jsonl");
const webhookServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry = {
      event: req.headers["x-agentic-git-event"] || "",
      signature: req.headers["x-agentic-git-signature"] || "",
      receivedAt: new Date().toISOString(),
      body: JSON.parse(raw),
    };
    await fs.appendFile(webhookLogPath, JSON.stringify(entry) + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
const webhookUrl = `http://127.0.0.1:${webhookServer.address().port}/webhook`;

// 4. Start agentic-git server (serving API + Git Smart-HTTP proxy + built Web UI)
const ctx = createApp({
  dbPath: path.join(rootDir, "agentic-git.db"),
  webDistDir: path.resolve("packages/web/dist"),
});
const agitServer = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((resolve) => agitServer.once("listening", resolve));
const agitUrl = `http://127.0.0.1:${agitServer.address().port}`;

async function api(token, method, route, body) {
  const res = await fetch(`${agitUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${method} ${route} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

// 5. Provision Alice (human owner) + 3 distinct agent bots owned by Alice
const alice = await api(ctx.adminToken, "POST", "/api/actors", {
  handle: "alice",
  displayName: "Alice (Human Owner)",
  type: "human",
  role: "maintainer",
  canMerge: true,
  canApprove: true,
  upstreamToken: "alice_upstream_secret_token",
});

const coderBot = await api(alice.token, "POST", "/api/actors", {
  handle: "coder-bot",
  displayName: "Coder Subagent",
  type: "agent",
  role: "agent",
  allowedBranchPatterns: ["agent/**"],
  canMerge: false,
  canApprove: false,
  agentWebhookUrl: webhookUrl,
});

const testReviewerBot = await api(alice.token, "POST", "/api/actors", {
  handle: "test-reviewer-bot",
  displayName: "Test Reviewer Subagent",
  type: "agent",
  role: "agent",
  allowedBranchPatterns: ["agent/**"],
  canMerge: false,
  canApprove: true,
  agentWebhookUrl: webhookUrl,
});

const securityReviewerBot = await api(alice.token, "POST", "/api/actors", {
  handle: "security-reviewer-bot",
  displayName: "Security Reviewer Subagent",
  type: "agent",
  role: "agent",
  allowedBranchPatterns: ["agent/**"],
  canMerge: false,
  canApprove: true,
  agentWebhookUrl: webhookUrl,
});

// 6. Register sandbox/todo-lib with custom merge gate, agent diff filter, and custom comment type
await api(alice.token, "POST", "/api/repos", {
  slug: "sandbox/todo-lib",
  forgeType: "local",
  forgeBaseUrl: "local://upstream",
  upstreamRepo: bareRepoPath,
  upstreamGitUrl: `${upstreamGit.url}/sandbox/todo-lib.git`,
  upstreamToken: "",
  defaultBranch: "main",
  credentialMode: "per_user",
  protectedBranches: ["main"],
  mergePolicy: {
    requireCiPassed: true,
    requiredChecks: ["node-test"],
    minApprovals: 2,
    requiredApprovers: ["test-reviewer-bot", "security-reviewer-bot"],
    blockOnErrorFindings: true,
    defaultAutoMerge: true,
  },
  diffFilterRules: [
    {
      id: "hide-tests-for-humans",
      name: "Hide test files reviewed by test-reviewer-bot",
      description: "Humans skip test diffs once test-reviewer-bot approves",
      filePatterns: ["**/*.test.js", "**/test/**"],
      hideForActorTypes: ["human"],
      hideForHandles: [],
      whenAgentAssigned: "test-reviewer-bot",
      whenAgentApproved: "test-reviewer-bot",
      enabled: true,
    },
  ],
  customCommentTypes: [
    {
      key: "follow_up_perf",
      label: "Follow-up Perf",
      description: "Track performance optimization for a later PR",
      blocksMerge: false,
      agentInstruction: "DO NOT optimize in this PR. Note for future performance PR.",
      color: "#0ea5e9",
      builtin: false,
    },
  ],
});

await api(alice.token, "POST", "/api/repos/sandbox/todo-lib/webhooks", {
  url: webhookUrl,
  secret: "sandbox_webhook_secret",
  events: [
    "pr.opened",
    "pr.updated",
    "comment.created",
    "comment.resolved",
    "review.submitted",
    "ci.updated",
    "pr.merged",
    "agent.invoked",
  ],
});

const envInfo = {
  rootDir,
  bareRepoPath,
  agitUrl,
  upstreamGitUrl: upstreamGit.url,
  webhookUrl,
  webhookLogPath,
  repoSlug: "sandbox/todo-lib",
  cliBin: path.resolve("packages/cli/dist/index.js"),
  tokens: {
    admin: ctx.adminToken,
    alice: alice.token,
    coderBot: coderBot.token,
    testReviewerBot: testReviewerBot.token,
    securityReviewerBot: securityReviewerBot.token,
  },
};

await fs.writeFile(path.join(rootDir, "env.json"), JSON.stringify(envInfo, null, 2));
console.log("SANDBOX_READY " + JSON.stringify({ agitUrl, webhookUrl, rootDir }));

process.on("SIGTERM", async () => {
  agitServer.close();
  await upstreamGit.close();
  webhookServer.close();
  process.exit(0);
});
