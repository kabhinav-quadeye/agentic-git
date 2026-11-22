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
});
