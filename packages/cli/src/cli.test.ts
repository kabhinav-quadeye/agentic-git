import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/dist/index.js";
import { inferRepoSlugFromGit } from "./config.js";

const execFileAsync = promisify(execFile);

describe("agit CLI", () => {
  let tmpDir: string;
  let server: ReturnType<typeof serve>;
  let serverUrl: string;
  let adminToken: string;
  const cliEntry = path.resolve(import.meta.dirname, "../dist/index.js");

  async function runCli(args: string[], extraEnv?: Record<string, string>) {
    const { stdout } = await execFileAsync("node", [cliEntry, ...args], {
      env: {
        ...process.env,
        AGIT_URL: serverUrl,
        AGIT_TOKEN: adminToken,
        ...extraEnv,
      },
    });
    return stdout;
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agit-cli-test-"));
    const ctx = createApp({ dbPath: path.join(tmpDir, "cli.db") });
    adminToken = ctx.adminToken;
    server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("infers repo slug from git remote URL pointed at agentic-git", async () => {
    const repoDir = path.join(tmpDir, "fake-repo");
    await fs.mkdir(repoDir);
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "http://bot:tok@127.0.0.1:4321/git/acme/payments.git"],
      { cwd: repoDir },
    );
    expect(inferRepoSlugFromGit(repoDir)).toBe("acme/payments");
  });

  it("executes whoami and agent create/list with --json output", async () => {
    const whoRaw = await runCli(["whoami", "--json"]);
    const who = JSON.parse(whoRaw) as { actor: { handle: string } };
    expect(who.actor.handle).toBe("admin");

    const createdRaw = await runCli([
      "agent",
      "create",
      "--handle",
      "cli-bot",
      "--name",
      "CLI Test Bot",
      "--branches",
      "agent/**",
      "--json",
    ]);
    const created = JSON.parse(createdRaw) as { actor: { handle: string }; token: string };
    expect(created.actor.handle).toBe("cli-bot");
    expect(created.token.startsWith("agit_bot_")).toBe(true);

    // Authenticate as the newly created bot using AGIT_TOKEN
    const botWhoRaw = await runCli(["whoami", "--json"], { AGIT_TOKEN: created.token });
    const botWho = JSON.parse(botWhoRaw) as { actor: { handle: string; type: string }; owner: { handle: string } };
    expect(botWho.actor.handle).toBe("cli-bot");
    expect(botWho.actor.type).toBe("agent");
    expect(botWho.owner.handle).toBe("admin");
  });

  it("closes an open PR via `agit pr close` and supports `--method` on `agit pr merge`", async () => {
    const bareRepo = path.join(tmpDir, "bare-cli.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bareRepo]);
    const seed = path.join(tmpDir, "seed-cli");
    await fs.mkdir(seed);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Seed"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "seed@cli.dev"], { cwd: seed });
    await fs.writeFile(path.join(seed, "a.txt"), "base\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: seed });
    await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: seed });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: seed });

    await execFileAsync("git", ["checkout", "-b", "feat/close-me"], { cwd: seed });
    await fs.writeFile(path.join(seed, "b.txt"), "b\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "b"], { cwd: seed });
    await execFileAsync("git", ["push", "-u", "origin", "feat/close-me"], { cwd: seed });

    await execFileAsync("git", ["checkout", "-b", "feat/merge-me", "main"], { cwd: seed });
    await fs.writeFile(path.join(seed, "c.txt"), "c\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "c"], { cwd: seed });
    await execFileAsync("git", ["push", "-u", "origin", "feat/merge-me"], { cwd: seed });

    const repoRes = await fetch(`${serverUrl}/api/repos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "acme/cli-test",
        forgeType: "local",
        forgeBaseUrl: "local://upstream",
        upstreamRepo: bareRepo,
        upstreamGitUrl: bareRepo,
        mergePolicy: { requireCiPassed: false, minApprovals: 0 },
      }),
    });
    expect(repoRes.status).toBe(201);

    const pr1 = JSON.parse(
      await runCli(["--repo", "acme/cli-test", "pr", "create", "--title", "Close me", "--head", "feat/close-me", "--json"]),
    ) as { pr: { number: number } };
    const closed = JSON.parse(
      await runCli(["--repo", "acme/cli-test", "pr", "close", String(pr1.pr.number), "--json"]),
    ) as { pr: { status: string } };
    expect(closed.pr.status).toBe("closed");

    const pr2 = JSON.parse(
      await runCli(["--repo", "acme/cli-test", "pr", "create", "--title", "Merge me", "--head", "feat/merge-me", "--json"]),
    ) as { pr: { number: number } };
    const merged = JSON.parse(
      await runCli(["--repo", "acme/cli-test", "pr", "merge", String(pr2.pr.number), "--method", "merge", "--json"]),
    ) as { pr: { status: string }; mergedSha: string };
    expect(merged.pr.status).toBe("merged");
    expect(merged.mergedSha).toBeTruthy();
  });
});
