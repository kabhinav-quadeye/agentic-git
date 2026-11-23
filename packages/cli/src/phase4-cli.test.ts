import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/dist/index.js";

const execFileAsync = promisify(execFile);

describe("Phase 4 — Built-in MCP server, agit doctor, presets, follow-ups, and fix-blocking", () => {
  let tmpDir: string;
  let server: ReturnType<typeof serve>;
  let serverUrl: string;
  let adminToken: string;
  const cliEntry = path.resolve(import.meta.dirname, "../dist/index.js");

  async function runCli(args: string[], extraEnv?: Record<string, string>): Promise<string> {
    const { stdout } = await execFileAsync("node", [cliEntry, ...args], {
      cwd: tmpDir,
      env: {
        ...process.env,
        AGIT_URL: serverUrl,
        AGIT_TOKEN: adminToken,
        AGIT_REPO: "acme/mcp-demo",
        ...extraEnv,
      },
    });
    return stdout;
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agit-p4-cli-"));
    const ctx = createApp({ dbPath: path.join(tmpDir, "p4.db") });
    adminToken = ctx.adminToken;
    server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;

    const hdr = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
    await fetch(`${serverUrl}/api/repos`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        slug: "acme/mcp-demo",
        forgeType: "local",
        forgeBaseUrl: "local://upstream",
        upstreamRepo: "/tmp/unused",
        upstreamGitUrl: "/tmp/unused",
      }),
    });
    await fetch(`${serverUrl}/api/actors`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        handle: "mcp-fixer",
        displayName: "MCP Fixer",
        type: "agent",
        role: "agent",
      }),
    });
    const pr = (
      (await (
        await fetch(`${serverUrl}/api/repos/acme/mcp-demo/prs`, {
          method: "POST",
          headers: hdr,
          body: JSON.stringify({
            title: "MCP Demo PR",
            sourceBranch: "agent/mcp",
            headSha: "sha_mcp_1",
          }),
        })
      ).json()) as { pr: { number: number } }
    ).pr;

    await fetch(`${serverUrl}/api/repos/acme/mcp-demo/prs/${pr.number}/comments`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        commentType: "blocking",
        body: "Validate webhook signature",
        filePath: "src/hook.ts",
        line: 10,
      }),
    });
    await fetch(`${serverUrl}/api/repos/acme/mcp-demo/prs/${pr.number}/comments`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        commentType: "defer_to_next_pr",
        body: "Add metrics counter later",
        filePath: "src/hook.ts",
        line: 20,
      }),
    });
  });

  afterAll(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs agit doctor, applies diff-filter presets, lists followups, and dispatches pr fix", async () => {
    const doc = JSON.parse(await runCli(["doctor", "--json"])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(doc.checks.find((c) => c.name === "server_health")?.status).toBe("ok");
    expect(doc.checks.find((c) => c.name === "authentication")?.status).toBe("ok");

    const preset = JSON.parse(
      await runCli(["repo", "preset", "hide-lockfiles", "--json"]),
    ) as { appliedRule: { id: string } };
    expect(preset.appliedRule.id).toBe("hide-lockfiles");

    const followups = JSON.parse(await runCli(["pr", "followups", "1", "--json"])) as {
      items: Array<{ body: string }>;
      markdown: string;
    };
    expect(followups.items[0].body).toBe("Add metrics counter later");
    expect(followups.markdown).toContain("- [ ]");

    const fix = JSON.parse(
      await runCli(["pr", "fix", "1", "--agent", "mcp-fixer", "--json"]),
    ) as {
      ok: boolean;
      bundle: { blockingComments: unknown[] };
    };
    expect(fix.ok).toBe(true);
    expect(fix.bundle.blockingComments).toHaveLength(1);
  });

  it("serves JSON-RPC 2.0 MCP tools over stdio via `agit mcp`", async () => {
    const child = spawn("node", [cliEntry, "mcp"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        AGIT_URL: serverUrl,
        AGIT_TOKEN: adminToken,
        AGIT_REPO: "acme/mcp-demo",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: Array<Record<string, unknown>> = [];
    let buffer = "";

    const waitForCount = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${count} MCP responses (got ${responses.length})`)), 5000);
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            responses.push(JSON.parse(trimmed) as Record<string, unknown>);
          }
          if (responses.length >= count) {
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
      });

    const send = (msg: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    };

    try {
      const p1 = waitForCount(4);
      send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
      send({ id: 2, method: "tools/list", params: {} });
      send({ id: 3, method: "tools/call", params: { name: "agit_pr_comments", arguments: { prNumber: 1, unresolvedOnly: true } } });
      send({ id: 4, method: "tools/call", params: { name: "agit_pr_followups", arguments: { prNumber: 1 } } });
      await p1;

      const initRes = responses.find((r) => r.id === 1) as { result: { serverInfo: { name: string } } };
      expect(initRes.result.serverInfo.name).toBe("agentic-git");

      const listRes = responses.find((r) => r.id === 2) as { result: { tools: Array<{ name: string }> } };
      const toolNames = listRes.result.tools.map((t) => t.name);
      expect(toolNames).toContain("agit_pr_comments");
      expect(toolNames).toContain("agit_pr_gate");
      expect(toolNames).toContain("agit_pr_fix_blocking");
      expect(toolNames).toContain("agit_pr_followups");

      const commentsRes = responses.find((r) => r.id === 3) as {
        result: { content: Array<{ text: string }> };
      };
      const parsedComments = JSON.parse(commentsRes.result.content[0].text) as {
        comments: Array<{ commentType: string; commentTypeMeta?: { agentInstruction?: string } }>;
      };
      expect(parsedComments.comments.length).toBe(2);
      expect(parsedComments.comments[0].commentTypeMeta?.agentInstruction).toContain("REQUIRED BEFORE MERGE");

      const fuRes = responses.find((r) => r.id === 4) as {
        result: { content: Array<{ text: string }> };
      };
      const parsedFu = JSON.parse(fuRes.result.content[0].text) as { markdown: string };
      expect(parsedFu.markdown).toContain("Add metrics counter later");
    } finally {
      child.stdin.end();
      child.kill();
    }
  });
});
