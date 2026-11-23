import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, startLocalGitHttpServer } from "../../server/dist/index.js";
import { inferRepoSlugFromGit, parseGitRemoteUrl } from "./config.js";

const execFileAsync = promisify(execFile);

function runCliWithStdin(
  cliEntry: string,
  args: string[],
  stdinText: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [cliEntry, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

describe("Phase 2 — 60-second migration, git credential helper & gh CLI parity", () => {
  let tmpDir: string;
  let bareRoot: string;
  let bareRepo: string;
  let upstreamGit: Awaited<ReturnType<typeof startLocalGitHttpServer>>;
  let server: ReturnType<typeof serve>;
  let serverUrl: string;
  let adminToken: string;
  let cfgDir: string;
  const cliEntry = path.resolve(import.meta.dirname, "../dist/index.js");

  async function runCli(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<string> {
    const { stdout } = await execFileAsync("node", [cliEntry, ...args], {
      cwd: opts?.cwd ?? tmpDir,
      env: {
        ...process.env,
        AGIT_CONFIG_DIR: cfgDir,
        AGIT_URL: serverUrl,
        AGIT_TOKEN: adminToken,
        ...opts?.env,
      },
    });
    return stdout;
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agit-p2-cli-"));
    cfgDir = path.join(tmpDir, "cfg");
    bareRoot = path.join(tmpDir, "upstream");
    bareRepo = path.join(bareRoot, "acme", "shop.git");
    await fs.mkdir(path.dirname(bareRepo), { recursive: true });
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bareRepo]);

    const seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "alice@acme.dev"], { cwd: seed });
    await fs.writeFile(path.join(seed, "README.md"), "# Shop\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: seed });
    await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: seed });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: seed });

    upstreamGit = await startLocalGitHttpServer({ projectRoot: bareRoot });
    const ctx = createApp({ dbPath: path.join(tmpDir, "p2.db") });
    adminToken = ctx.adminToken;
    server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
    await upstreamGit.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses GitHub HTTPS, GitHub SSH, GitLab, and agentic-git remote URLs and prefers agit remote", async () => {
    expect(parseGitRemoteUrl("https://github.com/acme/shop.git")).toEqual({
      slug: "acme/shop",
      forgeType: "github",
      host: "github.com",
    });
    expect(parseGitRemoteUrl("git@github.com:acme/shop.git")).toEqual({
      slug: "acme/shop",
      forgeType: "github",
      host: "github.com",
    });
    expect(parseGitRemoteUrl("ssh://git@github.com/acme/shop.git")).toEqual({
      slug: "acme/shop",
      forgeType: "github",
      host: "github.com",
    });
    expect(parseGitRemoteUrl("http://bot:tok@127.0.0.1:4321/git/acme/shop.git")).toEqual({
      slug: "acme/shop",
      forgeType: "local",
      host: "127.0.0.1:4321",
    });

    const repoDir = path.join(tmpDir, "multi-remote");
    await fs.mkdir(repoDir);
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: repoDir });
    expect(inferRepoSlugFromGit(repoDir)).toBe("acme/shop");

    await execFileAsync(
      "git",
      ["remote", "add", "agit", "http://127.0.0.1:4321/git/acme/override-shop.git"],
      { cwd: repoDir },
    );
    expect(inferRepoSlugFromGit(repoDir)).toBe("acme/override-shop");
  });

  it("supports agit auth login/status/token and git-credential helper without leaking tokens to other hosts", async () => {
    const loginOut = await runCli(
      ["auth", "login", "--server", serverUrl, "--token", adminToken, "--json"],
      { env: { AGIT_URL: "", AGIT_TOKEN: "" } },
    );
    expect(JSON.parse(loginOut)).toMatchObject({ ok: true, serverUrl });

    const statusOut = JSON.parse(
      await runCli(["auth", "status", "--json"], { env: { AGIT_URL: "", AGIT_TOKEN: "" } }),
    ) as { authenticated: boolean; actor: { handle: string } };
    expect(statusOut.authenticated).toBe(true);
    expect(statusOut.actor.handle).toBe("admin");

    const tokOut = (
      await runCli(["auth", "token"], { env: { AGIT_URL: "", AGIT_TOKEN: "" } })
    ).trim();
    expect(tokOut).toBe(adminToken);

    const parsedServer = new URL(serverUrl);
    const credGood = await runCliWithStdin(
      cliEntry,
      ["git-credential", "get"],
      `protocol=http\nhost=${parsedServer.host}\npath=/git/acme/shop.git\n\n`,
      { ...process.env, AGIT_CONFIG_DIR: cfgDir },
    );
    expect(credGood.code).toBe(0);
    expect(credGood.stdout).toContain(`password=${adminToken}`);

    const credOther = await runCliWithStdin(
      cliEntry,
      ["git-credential", "get"],
      `protocol=https\nhost=github.com\n\n`,
      { ...process.env, AGIT_CONFIG_DIR: cfgDir },
    );
    expect(credOther.code).toBe(0);
    expect(credOther.stdout.trim()).toBe("");
  });

  it("onboards a repo with `agit init` and supports full gh muscle-memory PR workflow", async () => {
    // Create a reviewer human so PR can be approved without self-approval
    const revOut = JSON.parse(
      await runCli([
        "user",
        "create",
        "--handle",
        "bob",
        "--name",
        "Bob Reviewer",
        "--role",
        "maintainer",
        "--json",
      ]),
    ) as { actor: { handle: string }; token: string };
    expect(revOut.actor.handle).toBe("bob");

    // Clone upstream as an existing developer checkout
    const devDir = path.join(tmpDir, "dev-checkout");
    await execFileAsync("git", ["clone", bareRepo, devDir]);
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: devDir });
    await execFileAsync("git", ["config", "user.email", "alice@acme.dev"], { cwd: devDir });
    await execFileAsync("git", ["remote", "set-url", "origin", `${upstreamGit.url}/acme/shop.git`], {
      cwd: devDir,
    });

    // Onboard repo with `agit init`
    const initOut = JSON.parse(
      await runCli(
        [
          "init",
          "--slug",
          "acme/shop",
          "--forge",
          "local",
          "--upstream-repo",
          bareRepo,
          "--upstream-git-url",
          `${upstreamGit.url}/acme/shop.git`,
          "--no-ci",
          "--json",
        ],
        { cwd: devDir },
      ),
    ) as { repo: { slug: string } };
    expect(initOut.repo.slug).toBe("acme/shop");

    // Create a feature branch and commit WITHOUT pushing first!
    await execFileAsync("git", ["checkout", "-b", "feat/cart"], { cwd: devDir });
    await fs.writeFile(path.join(devDir, "cart.ts"), "export const items = [];\n");
    await execFileAsync("git", ["add", "."], { cwd: devDir });
    await execFileAsync("git", ["commit", "-m", "Add shopping cart\n\nIncludes empty cart array."], {
      cwd: devDir,
    });

    // `agit pr create --fill` auto-fills title/body from commit AND auto-pushes branch!
    const created = JSON.parse(
      await runCli(["pr", "create", "--fill", "--json"], { cwd: devDir }),
    ) as { pr: { number: number; title: string; description: string } };
    expect(created.pr.title).toBe("Add shopping cart");
    expect(created.pr.description).toContain("empty cart array");

    // `agit pr list --state open --mine`
    const listed = JSON.parse(
      await runCli(["pr", "list", "--state", "open", "--mine", "--json"], { cwd: devDir }),
    ) as { prs: Array<{ number: number }> };
    expect(listed.prs.map((p) => p.number)).toContain(created.pr.number);

    // Branch-inferred `pr view`, `pr diff`, `pr checks`, `pr edit`, `pr status` (NO number argument!)
    const viewed = JSON.parse(await runCli(["pr", "view", "--json"], { cwd: devDir })) as {
      pr: { number: number };
    };
    expect(viewed.pr.number).toBe(created.pr.number);

    const diffed = JSON.parse(await runCli(["pr", "diff", "--json"], { cwd: devDir })) as {
      visibleFiles: Array<{ path: string }>;
    };
    expect(diffed.visibleFiles.map((f) => f.path)).toEqual(["cart.ts"]);

    const checks = JSON.parse(await runCli(["pr", "checks", "--json"], { cwd: devDir })) as {
      gate: { ci: { passed: boolean } };
    };
    expect(checks.gate.ci.passed).toBe(true);

    const edited = JSON.parse(
      await runCli(["pr", "edit", "-t", "Add shopping cart v2", "--json"], { cwd: devDir }),
    ) as { pr: { title: string } };
    expect(edited.pr.title).toBe("Add shopping cart v2");

    const statusRes = JSON.parse(await runCli(["pr", "status", "--json"], { cwd: devDir })) as {
      currentBranchPr: { number: number } | null;
    };
    expect(statusRes.currentBranchPr?.number).toBe(created.pr.number);

    // Close & reopen without passing number (inferred from current branch!)
    const closed = JSON.parse(await runCli(["pr", "close", "--json"], { cwd: devDir })) as {
      pr: { status: string };
    };
    expect(closed.pr.status).toBe("closed");

    const reopened = JSON.parse(await runCli(["pr", "reopen", "--json"], { cwd: devDir })) as {
      pr: { status: string };
    };
    expect(reopened.pr.status).toBe("open");

    // Review with gh-style `--approve -b ...`
    const reviewed = JSON.parse(
      await runCli(["pr", "review", String(created.pr.number), "--approve", "-b", "Ship it!"], {
        cwd: devDir,
        env: { AGIT_TOKEN: revOut.token },
      }).then(() => runCli(["pr", "view", "--json"], { cwd: devDir })),
    ) as { gate: { canMerge: boolean } };
    expect(reviewed.gate.canMerge).toBe(true);

    // Merge with gh-style `--squash` (inferred PR number!)
    const merged = JSON.parse(
      await runCli(["pr", "merge", "--squash", "--json"], { cwd: devDir }),
    ) as { pr: { status: string }; mergedSha: string };
    expect(merged.pr.status).toBe("merged");
    expect(merged.mergedSha).toBeTruthy();

    // Webhook CLI CRUD
    const whAdded = JSON.parse(
      await runCli(
        ["webhook", "add", "--url", "https://example.test/hook", "--events", "pr.opened,pr.merged", "--json"],
        { cwd: devDir },
      ),
    ) as { webhook: { id: string } };
    expect(whAdded.webhook.id).toBeTruthy();
    const whDel = JSON.parse(
      await runCli(["webhook", "delete", whAdded.webhook.id, "--json"], { cwd: devDir }),
    ) as { ok: boolean };
    expect(whDel.ok).toBe(true);
  });
});
