#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import type {
  Actor,
  FilteredDiffResponse,
  ForgeType,
  MergeGateResult,
  PrComment,
  PrReview,
  PullRequest,
  PushAuditEntry,
  Repo,
  WebhookSubscription,
} from "@agentic-git/shared";
import { AgitApiError, AgitClient } from "./client.js";
import {
  checkoutBranchFromGitRemote,
  getConfigPath,
  getGitRemoteUrl,
  getHeadCommitSummary,
  getPreferredGitRemote,
  inferCurrentBranch,
  inferDefaultBranch,
  inferRepoSlugFromGit,
  loadConfig,
  parseGitRemoteUrl,
  saveConfig,
  setupGitCredentialHelper,
  tryReadGhAuthToken,
} from "./config.js";

interface GlobalOpts {
  server?: string;
  token?: string;
  repo?: string;
  json?: boolean;
}

function getClient(cmd: Command): {
  client: AgitClient;
  opts: GlobalOpts;
  cfg: ReturnType<typeof loadConfig>;
} {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  const cfg = loadConfig({ server: opts.server, token: opts.token });
  return { client: new AgitClient(cfg), opts, cfg };
}

function resolveRepo(opts: GlobalOpts): string {
  const slug = opts.repo ?? process.env.AGIT_REPO ?? inferRepoSlugFromGit();
  if (!slug) {
    throw new Error(
      "Could not infer repository slug. Pass --repo <org/repo> or run inside a git repository with a GitHub, GitLab, or agentic-git remote.",
    );
  }
  return slug;
}

async function resolvePrNumber(
  client: AgitClient,
  slug: string,
  numStr?: string,
): Promise<string> {
  if (numStr) return numStr;
  const branch = inferCurrentBranch();
  if (!branch) {
    throw new Error("Could not infer PR number (detached HEAD). Pass a PR number explicitly.");
  }
  const data = await client.request<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
    "GET",
    `/api/repos/${slug}/prs`,
  );
  const openMatch = data.prs.find((p) => p.sourceBranch === branch && p.status === "open");
  const anyMatch = openMatch ?? data.prs.find((p) => p.sourceBranch === branch);
  if (!anyMatch) {
    throw new Error(
      `No pull request found for current branch '${branch}' in '${slug}'. Pass a PR number or run \`agit pr create\`.`,
    );
  }
  return String(anyMatch.number);
}

function pushBranchWithAuth(
  branch: string,
  cfg: { serverUrl: string; token: string },
  cwd = process.cwd(),
): void {
  const remote = getPreferredGitRemote(cwd);
  const remoteUrl = getGitRemoteUrl(remote, cwd) ?? "";
  const gitArgs: string[] = [];
  if (cfg.token && remoteUrl.startsWith(cfg.serverUrl)) {
    gitArgs.push("-c", `http.extraHeader=Authorization: Bearer ${cfg.token}`);
  }
  gitArgs.push("push", "-u", remote, branch);
  execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function printOutput(opts: GlobalOpts, data: unknown, humanFn: () => void): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

async function readStdinText(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.resume();
  });
}

async function runInitRepo(
  cmdOpts: {
    slug?: string;
    forge?: ForgeType;
    upstreamRepo?: string;
    upstreamGitUrl?: string;
    upstreamToken?: string;
    webhookSecret?: string;
    defaultBranch?: string;
    credentialMode?: "service" | "per_user";
    protected?: string;
    ci?: boolean;
    minApprovals?: string;
    addRemote?: boolean;
    setOrigin?: boolean;
    setupGit?: boolean;
    sync?: boolean;
  },
  cmd: Command,
): Promise<void> {
  const { client, opts, cfg } = getClient(cmd);
  const originUrl = getGitRemoteUrl("origin");
  const parsedOrigin = originUrl ? parseGitRemoteUrl(originUrl) : null;

  const slug = cmdOpts.slug ?? opts.repo ?? parsedOrigin?.slug;
  if (!slug) {
    throw new Error(
      "Could not detect repository slug. Run inside a git repository or pass --slug <org/repo>.",
    );
  }
  const forgeType: ForgeType = cmdOpts.forge ?? parsedOrigin?.forgeType ?? "github";
  const upstreamRepo = cmdOpts.upstreamRepo ?? slug;
  const upstreamGitUrl =
    cmdOpts.upstreamGitUrl ??
    (forgeType === "github"
      ? `https://github.com/${upstreamRepo}.git`
      : forgeType === "gitlab"
        ? `https://gitlab.com/${upstreamRepo}.git`
        : originUrl ?? upstreamRepo);
  const forgeBaseUrl =
    forgeType === "github"
      ? "https://api.github.com"
      : forgeType === "gitlab"
        ? "https://gitlab.com"
        : "local://upstream";
  const defaultBranch = cmdOpts.defaultBranch ?? inferDefaultBranch();
  const upstreamToken =
    cmdOpts.upstreamToken ?? (forgeType === "github" ? (tryReadGhAuthToken() ?? "") : "");
  const protectedBranches = (cmdOpts.protected ?? defaultBranch)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    slug,
    forgeType,
    forgeBaseUrl,
    upstreamRepo,
    upstreamGitUrl,
    upstreamToken,
    incomingWebhookSecret: cmdOpts.webhookSecret ?? "",
    defaultBranch,
    credentialMode: cmdOpts.credentialMode ?? "service",
    protectedBranches,
    mergePolicy: {
      requireCiPassed: cmdOpts.ci !== false,
      minApprovals: cmdOpts.minApprovals ? Number.parseInt(cmdOpts.minApprovals, 10) : 1,
    },
  };

  let repo: Repo;
  let alreadyExisted = false;
  try {
    const created = await client.request<{ repo: Repo }>("POST", "/api/repos", payload);
    repo = created.repo;
  } catch (err) {
    if (err instanceof AgitApiError && err.status === 409) {
      const existing = await client.request<{ repo: Repo }>("GET", `/api/repos/${slug}`);
      repo = existing.repo;
      alreadyExisted = true;
    } else {
      throw err;
    }
  }

  let synced: { imported: number; updated: number } | null = null;
  if (cmdOpts.sync !== false && forgeType !== "local") {
    try {
      const s = await client.request<{ imported: number; updated: number }>(
        "POST",
        `/api/repos/${slug}/sync`,
      );
      synced = { imported: s.imported, updated: s.updated };
    } catch {
      // non-fatal during onboarding if upstream token has limited scopes
    }
  }

  const proxyUrl = `${cfg.serverUrl}/git/${slug}.git`;
  if (cmdOpts.setOrigin && originUrl) {
    try {
      execFileSync("git", ["remote", "rename", "origin", "upstream-forge"], { stdio: "ignore" });
    } catch {
      // ignore if rename fails
    }
    execFileSync("git", ["remote", "add", "origin", proxyUrl], { stdio: "ignore" });
  } else if (cmdOpts.addRemote) {
    if (getGitRemoteUrl("agit")) {
      execFileSync("git", ["remote", "set-url", "agit", proxyUrl], { stdio: "ignore" });
    } else {
      execFileSync("git", ["remote", "add", "agit", proxyUrl], { stdio: "ignore" });
    }
  }

  if (cmdOpts.setupGit) {
    setupGitCredentialHelper(cfg.serverUrl);
  }

  printOutput(opts, { ok: true, alreadyExisted, repo, proxyUrl, synced }, () => {
    console.log(`${alreadyExisted ? "Connected existing" : "Registered"} repo '${repo.slug}' [${repo.forgeType}]`);
    console.log(`  Proxy URL: ${proxyUrl}`);
    console.log(`  Upstream:  ${repo.upstreamRepo} (default branch: ${repo.defaultBranch})`);
    if (synced) {
      console.log(`  Synced PRs: ${synced.imported} imported, ${synced.updated} updated`);
    }
  });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("agit")
    .description("Agent-native Git & PR workflow CLI (drop-in companion for gh & github.com)")
    .version("0.2.0")
    .option("-s, --server <url>", "agentic-git server URL (or AGIT_URL)")
    .option("--token <token>", "actor or bot auth token (or AGIT_TOKEN)")
    .option("-r, --repo <org/repo>", "repository slug (auto-detected from git remote)")
    .option("--json", "output structured JSON (ideal for agents)", false);

  // ---- config (legacy alias) ----
  const cfgCmd = program.command("config").description("Configure server URL and auth token");
  cfgCmd
    .command("set")
    .option("--server <url>", "Server base URL")
    .option("--token <token>", "Auth token")
    .action((cmdOpts: { server?: string; token?: string }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOpts>();
      const saved = saveConfig({
        serverUrl: cmdOpts.server ?? globals.server,
        token: cmdOpts.token ?? globals.token,
      });
      printOutput(globals, { ok: true, serverUrl: saved.serverUrl, hasToken: Boolean(saved.token) }, () => {
        console.log(`Saved config -> server: ${saved.serverUrl}, token: ${saved.token ? "***" : "(empty)"}`);
      });
    });

  // ---- auth (gh-compatible) ----
  const authCmd = program.command("auth").description("Authenticate with agentic-git and configure Git credentials");

  authCmd
    .command("login")
    .description("Save server URL and access token (and optionally configure git credential helper)")
    .option("--server <url>", "Server base URL")
    .option("--token <token>", "Access token")
    .option("--setup-git", "Register `agit git-credential` as git credential helper for this server", false)
    .action((cmdOpts: { server?: string; token?: string; setupGit?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOpts>();
      const saved = saveConfig({
        serverUrl: cmdOpts.server ?? globals.server,
        token: cmdOpts.token ?? globals.token,
      });
      if (cmdOpts.setupGit) {
        setupGitCredentialHelper(saved.serverUrl);
      }
      printOutput(
        globals,
        {
          ok: true,
          serverUrl: saved.serverUrl,
          configPath: getConfigPath(),
          hasToken: Boolean(saved.token),
          gitCredentialConfigured: Boolean(cmdOpts.setupGit),
        },
        () => {
          console.log(`Logged in -> ${saved.serverUrl} (saved to ${getConfigPath()})`);
          if (cmdOpts.setupGit) {
            console.log(`Configured git credential helper for ${saved.serverUrl}`);
          }
        },
      );
    });

  authCmd
    .command("status")
    .description("Verify authentication and print active actor identity")
    .action(async (_opts, cmd: Command) => {
      const { client, opts, cfg } = getClient(cmd);
      const data = await client.request<{ actor: Actor; owner: Actor | null; hasUpstreamToken: boolean }>(
        "GET",
        "/api/me",
      );
      printOutput(
        opts,
        {
          authenticated: true,
          serverUrl: cfg.serverUrl,
          configPath: getConfigPath(),
          ...data,
        },
        () => {
          const ownerStr = data.owner ? ` (owned by ${data.owner.handle})` : "";
          console.log(`Logged in to ${cfg.serverUrl} as ${data.actor.handle} [${data.actor.type}/${data.actor.role}]${ownerStr}`);
          console.log(`  Branches: ${data.actor.allowedBranchPatterns.join(", ")}`);
          console.log(`  Permissions: approve=${data.actor.canApprove}, merge=${data.actor.canMerge}`);
          console.log(`  Upstream token configured: ${data.hasUpstreamToken ? "yes" : "no"}`);
        },
      );
    });

  authCmd
    .command("token")
    .description("Print the active access token")
    .action((_opts, cmd: Command) => {
      const { cfg } = getClient(cmd);
      if (!cfg.token) {
        throw new Error("No token configured. Run `agit auth login --server <url> --token <token>`.");
      }
      console.log(cfg.token);
    });

  authCmd
    .command("setup-git")
    .description("Configure git to authenticate against agentic-git without storing tokens in .git/config")
    .action((_opts, cmd: Command) => {
      const { opts, cfg } = getClient(cmd);
      setupGitCredentialHelper(cfg.serverUrl);
      printOutput(opts, { ok: true, serverUrl: cfg.serverUrl }, () => {
        console.log(`Configured git credential helper for ${cfg.serverUrl}`);
      });
    });

  // ---- git-credential helper ----
  program
    .command("git-credential <operation>")
    .description("Git credential helper protocol handler (used by `agit auth setup-git`)")
    .action(async (operation: string, _opts, cmd: Command) => {
      if (operation !== "get") return;
      const { cfg } = getClient(cmd);
      if (!cfg.token) return;
      const input = await readStdinText();
      const fields = new Map<string, string>();
      for (const line of input.split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx > 0) fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      }
      const reqHost = fields.get("host");
      if (!reqHost) return;
      let serverHost = "";
      try {
        serverHost = new URL(cfg.serverUrl).host;
      } catch {
        return;
      }
      if (reqHost === serverHost) {
        console.log("username=agit");
        console.log(`password=${cfg.token}`);
      }
    });

  // ---- whoami ----
  program
    .command("whoami")
    .description("Show the authenticated human or agent identity")
    .action(async (_opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const data = await client.request<{ actor: Actor; owner: Actor | null; hasUpstreamToken: boolean }>(
        "GET",
        "/api/me",
      );
      printOutput(opts, data, () => {
        const ownerStr = data.owner ? ` (owned by ${data.owner.handle})` : "";
        console.log(`${data.actor.handle} [${data.actor.type}/${data.actor.role}]${ownerStr}`);
        console.log(`  Branches: ${data.actor.allowedBranchPatterns.join(", ")}`);
        console.log(`  Permissions: approve=${data.actor.canApprove}, merge=${data.actor.canMerge}`);
      });
    });

  // ---- init (60-second onboarding) ----
  const addInitOptions = (c: Command) =>
    c
      .option("--slug <org/repo>", "Repository slug (auto-detected from git remote)")
      .option("--forge <type>", "Upstream forge: github | gitlab | local")
      .option("--upstream-repo <path>", "Upstream repo identifier (e.g. org/repo or bare path)")
      .option("--upstream-git-url <url>", "Upstream Git Smart-HTTP URL")
      .option("--upstream-token <token>", "Upstream PAT (auto-reads `gh auth token` for GitHub if omitted)")
      .option("--webhook-secret <secret>", "Shared secret for incoming GitHub/GitLab webhooks")
      .option("--default-branch <branch>", "Default branch name")
      .option("--credential-mode <mode>", "service | per_user", "service")
      .option("--protected <branches>", "Comma-separated protected branch globs")
      .option("--no-ci", "Do not require CI checks before merging")
      .option("--min-approvals <n>", "Minimum required approvals", "1")
      .option("--add-remote", "Add an `agit` git remote pointing at the proxy", false)
      .option("--set-origin", "Rename `origin` to `upstream-forge` and point `origin` at the proxy", false)
      .option("--setup-git", "Register git credential helper for this server", false)
      .option("--no-sync", "Skip initial upstream PR sync");

  addInitOptions(
    program
      .command("init")
      .description("Connect the current GitHub/GitLab/local repo to agentic-git in one step"),
  ).action(runInitRepo);

  // ---- repo ----
  const repoCmd = program.command("repo").description("Manage repositories, sync, policies, and push audit trails");

  addInitOptions(
    repoCmd.command("connect").description("Connect a repository to agentic-git (alias of `agit init`)"),
  ).action(runInitRepo);

  addInitOptions(
    repoCmd.command("add").description("Register a repository in agentic-git (alias of `agit init`)"),
  ).action(runInitRepo);

  repoCmd.command("list").action(async (_opts, cmd: Command) => {
    const { client, opts } = getClient(cmd);
    const data = await client.request<{ repos: Repo[] }>("GET", "/api/repos");
    printOutput(opts, data, () => {
      if (data.repos.length === 0) {
        console.log("No repositories registered.");
        return;
      }
      for (const r of data.repos) {
        console.log(`${r.slug}  [${r.forgeType}]  upstream=${r.upstreamRepo}  protected=${r.protectedBranches.join(",")}`);
      }
    });
  });

  repoCmd
    .command("sync")
    .description("Import and refresh open PRs and CI checks from upstream forge")
    .action(async (_opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ ok: boolean; imported: number; updated: number; prs: PullRequest[] }>(
        "POST",
        `/api/repos/${slug}/sync`,
      );
      printOutput(opts, data, () => {
        console.log(`Synced '${slug}': ${data.imported} imported, ${data.updated} updated`);
      });
    });

  repoCmd
    .command("delete [slug]")
    .description("Unregister a repository from agentic-git")
    .action(async (slugArg: string | undefined, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = slugArg ?? resolveRepo(opts);
      const data = await client.request<{ ok: boolean }>("DELETE", `/api/repos/${slug}`);
      printOutput(opts, data, () => {
        console.log(`Deleted repository '${slug}'`);
      });
    });

  repoCmd
    .command("policy")
    .description("View or update repository merge policy")
    .option("--min-approvals <n>", "Minimum approvals")
    .option("--required-checks <checks>", "Comma-separated required CI check names")
    .option("--required-approvers <handles>", "Comma-separated required approver handles")
    .option("--merge-method <method>", "merge | squash | rebase")
    .option("--require-ci <bool>", "true | false")
    .option("--invalidate-on-push <bool>", "true | false")
    .action(
      async (
        cmdOpts: {
          minApprovals?: string;
          requiredChecks?: string;
          requiredApprovers?: string;
          mergeMethod?: string;
          requireCi?: string;
          invalidateOnPush?: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const patch: Record<string, unknown> = {};
        if (cmdOpts.minApprovals !== undefined) patch.minApprovals = Number.parseInt(cmdOpts.minApprovals, 10);
        if (cmdOpts.requiredChecks !== undefined) {
          patch.requiredChecks = cmdOpts.requiredChecks.split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (cmdOpts.requiredApprovers !== undefined) {
          patch.requiredApprovers = cmdOpts.requiredApprovers.split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (cmdOpts.mergeMethod) patch.mergeMethod = cmdOpts.mergeMethod;
        if (cmdOpts.requireCi !== undefined) patch.requireCiPassed = cmdOpts.requireCi === "true";
        if (cmdOpts.invalidateOnPush !== undefined) {
          patch.invalidateApprovalsOnPush = cmdOpts.invalidateOnPush === "true";
        }

        const data =
          Object.keys(patch).length > 0
            ? await client.request<{ repo: Repo }>("PATCH", `/api/repos/${slug}`, { mergePolicy: patch })
            : await client.request<{ repo: Repo }>("GET", `/api/repos/${slug}`);

        printOutput(opts, data, () => {
          const mp = data.repo.mergePolicy;
          console.log(`Policy for ${data.repo.slug}:`);
          console.log(`  requireCiPassed=${mp.requireCiPassed}, requiredChecks=[${mp.requiredChecks.join(",")}]`);
          console.log(`  minApprovals=${mp.minApprovals}, requiredApprovers=[${mp.requiredApprovers.join(",")}]`);
          console.log(`  mergeMethod=${mp.mergeMethod}, invalidateApprovalsOnPush=${mp.invalidateApprovalsOnPush}`);
          console.log(`  allowSelfApproval=${mp.allowSelfApproval}, allowAuthorResolveBlocking=${mp.allowAuthorResolveBlocking}`);
        });
      },
    );

  repoCmd.command("pushes").action(async (_opts, cmd: Command) => {
    const { client, opts } = getClient(cmd);
    const slug = resolveRepo(opts);
    const data = await client.request<{ pushes: PushAuditEntry[] }>("GET", `/api/repos/${slug}/pushes`);
    printOutput(opts, data, () => {
      for (const p of data.pushes) {
        const owner = p.ownerHandle ? ` (owner:${p.ownerHandle})` : "";
        console.log(
          `${p.allowed ? "ALLOW" : "DENY "} ${p.actorHandle}${owner} -> ${p.ref} (${p.newSha.slice(0, 7)}) : ${p.reason}`,
        );
      }
    });
  });

  // ---- user ----
  const userCmd = program.command("user").description("Manage human developer accounts and upstream tokens");
  userCmd.command("list").action(async (_opts, cmd: Command) => {
    const { client, opts } = getClient(cmd);
    const data = await client.request<{ actors: Actor[] }>("GET", "/api/actors?type=human");
    printOutput(opts, data, () => {
      for (const a of data.actors) {
        console.log(`${a.handle} (${a.displayName}) role=${a.role} approve=${a.canApprove} merge=${a.canMerge}`);
      }
    });
  });

  userCmd
    .command("create")
    .requiredOption("--handle <handle>", "Unique user handle")
    .requiredOption("--name <displayName>", "Display name")
    .option("--role <role>", "admin | maintainer | developer", "developer")
    .option("--can-merge", "Allow user to merge PRs", false)
    .option("--upstream-token <token>", "Optional per-user upstream GitHub/GitLab PAT")
    .action(
      async (
        cmdOpts: {
          handle: string;
          name: string;
          role: string;
          canMerge?: boolean;
          upstreamToken?: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const data = await client.request<{ actor: Actor; token: string }>("POST", "/api/actors", {
          handle: cmdOpts.handle,
          displayName: cmdOpts.name,
          type: "human",
          role: cmdOpts.role,
          canMerge: cmdOpts.canMerge || cmdOpts.role === "admin" || cmdOpts.role === "maintainer",
          canApprove: true,
          upstreamToken: cmdOpts.upstreamToken,
        });
        printOutput(opts, data, () => {
          console.log(`Created user '${data.actor.handle}' [${data.actor.role}]`);
          console.log(`  Access token (save this): ${data.token}`);
        });
      },
    );

  userCmd
    .command("set-upstream-token")
    .description("Store a personal GitHub/GitLab PAT for per_user credential mode")
    .option("--token <pat>", "Upstream PAT (defaults to `gh auth token`)")
    .action(async (cmdOpts: { token?: string }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const pat = cmdOpts.token ?? tryReadGhAuthToken();
      if (!pat) {
        throw new Error("Pass --token <pat> or authenticate with `gh auth login` first.");
      }
      const me = await client.request<{ actor: Actor }>("GET", "/api/me");
      const data = await client.request<{ ok: boolean }>(
        "PATCH",
        `/api/actors/${me.actor.id}/upstream-token`,
        { upstreamToken: pat },
      );
      printOutput(opts, data, () => {
        console.log(`Updated upstream token for '${me.actor.handle}'`);
      });
    });

  // ---- webhook ----
  const webhookCmd = program.command("webhook").description("Manage outgoing repository webhooks");
  webhookCmd.command("list").action(async (_opts, cmd: Command) => {
    const { client, opts } = getClient(cmd);
    const slug = resolveRepo(opts);
    const data = await client.request<{ webhooks: WebhookSubscription[] }>(
      "GET",
      `/api/repos/${slug}/webhooks`,
    );
    printOutput(opts, data, () => {
      if (data.webhooks.length === 0) {
        console.log("No webhooks configured.");
        return;
      }
      for (const w of data.webhooks) {
        console.log(`${w.id}  ${w.url}  events=[${w.events.join(",")}]  enabled=${w.enabled}`);
      }
    });
  });

  webhookCmd
    .command("add")
    .requiredOption("--url <url>", "Webhook destination URL")
    .requiredOption("--events <list>", "Comma-separated event types")
    .option("--secret <secret>", "HMAC signing secret", "agentic-git-secret")
    .action(async (cmdOpts: { url: string; events: string; secret: string }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ webhook: WebhookSubscription }>(
        "POST",
        `/api/repos/${slug}/webhooks`,
        {
          url: cmdOpts.url,
          secret: cmdOpts.secret,
          events: cmdOpts.events.split(",").map((s) => s.trim()).filter(Boolean),
        },
      );
      printOutput(opts, data, () => {
        console.log(`Added webhook ${data.webhook.id} -> ${data.webhook.url}`);
      });
    });

  webhookCmd
    .command("delete <id>")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ ok: boolean }>("DELETE", `/api/repos/${slug}/webhooks/${id}`);
      printOutput(opts, data, () => {
        console.log(`Deleted webhook ${id}`);
      });
    });

  // ---- pr (gh-compatible + agentic extensions) ----
  const prCmd = program.command("pr").description("Pull requests, agent-filtered diffs, typed comments & merge gates");

  prCmd
    .command("list")
    .option("--status <status>", "Filter by status: open, merged, closed, all")
    .option("--state <state>", "Alias for --status (gh compatible)")
    .option("--author <handle>", "Filter by author handle")
    .option("--mine", "Show only PRs authored by the authenticated actor", false)
    .action(
      async (
        cmdOpts: { status?: string; state?: string; author?: string; mine?: boolean },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const st = cmdOpts.status ?? cmdOpts.state;
        const q = st && st !== "all" ? `?status=${encodeURIComponent(st)}` : "";
        const data = await client.request<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
          "GET",
          `/api/repos/${slug}/prs${q}`,
        );
        let prs = data.prs;
        if (cmdOpts.mine) {
          const me = await client.request<{ actor: Actor }>("GET", "/api/me");
          prs = prs.filter((p) => p.authorHandle === me.actor.handle);
        }
        if (cmdOpts.author) {
          prs = prs.filter((p) => p.authorHandle === cmdOpts.author);
        }
        printOutput(opts, { prs }, () => {
          if (prs.length === 0) {
            console.log("No pull requests found.");
            return;
          }
          for (const pr of prs) {
            const gateStr = pr.gate.canMerge ? "READY" : "BLOCKED";
            console.log(
              `#${pr.number} [${pr.status.toUpperCase()} | ${gateStr}] ${pr.title} (${pr.sourceBranch} -> ${pr.targetBranch}) by ${pr.authorHandle}`,
            );
          }
        });
      },
    );

  prCmd
    .command("status")
    .description("Show PR status for the current branch and your open PRs")
    .action(async (_opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const branch = inferCurrentBranch();
      const [me, allPrs] = await Promise.all([
        client.request<{ actor: Actor }>("GET", "/api/me"),
        client.request<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
          "GET",
          `/api/repos/${slug}/prs`,
        ),
      ]);
      const currentBranchPr = branch
        ? allPrs.prs.find((p) => p.sourceBranch === branch && p.status === "open") ??
          allPrs.prs.find((p) => p.sourceBranch === branch) ??
          null
        : null;
      const myOpenPrs = allPrs.prs.filter(
        (p) => p.status === "open" && p.authorHandle === me.actor.handle,
      );
      printOutput(opts, { branch, currentBranchPr, myOpenPrs }, () => {
        console.log(`Current branch (${branch ?? "detached"}):`);
        if (currentBranchPr) {
          console.log(
            `  #${currentBranchPr.number} [${currentBranchPr.status} | ${currentBranchPr.gate.canMerge ? "READY" : "BLOCKED"}] ${currentBranchPr.title}`,
          );
        } else {
          console.log("  No pull request for this branch.");
        }
        console.log(`Your open pull requests (${myOpenPrs.length}):`);
        for (const p of myOpenPrs) {
          console.log(`  #${p.number} [${p.gate.canMerge ? "READY" : "BLOCKED"}] ${p.title} (${p.sourceBranch})`);
        }
      });
    });

  prCmd
    .command("create")
    .option("-t, --title <title>", "PR title")
    .option("-b, --body <description>", "PR description")
    .option("--fill", "Auto-fill title and body from the latest commit message", false)
    .option("-H, --head <branch>", "Source branch (defaults to current git branch)")
    .option("-B, --base <branch>", "Target branch (defaults to repo default branch)")
    .option("--auto-merge", "Enable automatic merge once all merge gates pass", false)
    .option("--assign-agent <handles>", "Comma-separated agent handles assigned to this PR")
    .option("--no-push", "Do not auto-push the branch if missing upstream")
    .action(
      async (
        cmdOpts: {
          title?: string;
          body?: string;
          fill?: boolean;
          head?: string;
          base?: string;
          autoMerge?: boolean;
          assignAgent?: string;
          push?: boolean;
        },
        cmd: Command,
      ) => {
        const { client, opts, cfg } = getClient(cmd);
        const slug = resolveRepo(opts);
        const sourceBranch = cmdOpts.head ?? inferCurrentBranch();
        if (!sourceBranch) {
          throw new Error("Could not detect current branch; pass --head <branch>");
        }
        const commitSummary = cmdOpts.fill || !cmdOpts.title ? getHeadCommitSummary() : null;
        const title = cmdOpts.title ?? (cmdOpts.fill ? commitSummary?.title : undefined);
        if (!title) {
          throw new Error("PR title is required. Pass --title <title> (or -t) or use --fill.");
        }
        const description = cmdOpts.body ?? (cmdOpts.fill ? (commitSummary?.body ?? "") : "");
        const assignedAgents = cmdOpts.assignAgent
          ? cmdOpts.assignAgent.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

        const payload = {
          title,
          description,
          sourceBranch,
          targetBranch: cmdOpts.base,
          autoMerge: cmdOpts.autoMerge,
          assignedAgents,
        };

        let data: { pr: PullRequest };
        try {
          data = await client.request<{ pr: PullRequest }>("POST", `/api/repos/${slug}/prs`, payload);
        } catch (err) {
          // If branch hasn't been pushed yet and auto-push is allowed, push it seamlessly like `gh pr create`!
          if (
            cmdOpts.push !== false &&
            err instanceof AgitApiError &&
            err.status === 400 &&
            /not found upstream/i.test(err.message)
          ) {
            pushBranchWithAuth(sourceBranch, cfg);
            data = await client.request<{ pr: PullRequest }>("POST", `/api/repos/${slug}/prs`, payload);
          } else {
            throw err;
          }
        }

        printOutput(opts, data, () => {
          console.log(`Created PR #${data.pr.number}: ${data.pr.title}`);
          console.log(`  Branch: ${data.pr.sourceBranch} -> ${data.pr.targetBranch} (${data.pr.headSha.slice(0, 7)})`);
          if (data.pr.upstreamPrUrl) {
            console.log(`  Shadow PR: ${data.pr.upstreamPrUrl}`);
          }
        });
      },
    );

  prCmd
    .command("edit [number]")
    .description("Edit PR title, body, auto-merge, or assigned agents")
    .option("-t, --title <title>", "New PR title")
    .option("-b, --body <description>", "New PR description")
    .option("--auto-merge", "Enable auto-merge")
    .option("--no-auto-merge", "Disable auto-merge")
    .option("--assign-agent <handles>", "Comma-separated agent handles")
    .action(
      async (
        numStr: string | undefined,
        cmdOpts: {
          title?: string;
          body?: string;
          autoMerge?: boolean;
          assignAgent?: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const resolvedNum = await resolvePrNumber(client, slug, numStr);
        const patch: Record<string, unknown> = {};
        if (cmdOpts.title !== undefined) patch.title = cmdOpts.title;
        if (cmdOpts.body !== undefined) patch.description = cmdOpts.body;
        if (cmdOpts.autoMerge !== undefined) patch.autoMerge = cmdOpts.autoMerge;
        if (cmdOpts.assignAgent !== undefined) {
          patch.assignedAgents = cmdOpts.assignAgent.split(",").map((s) => s.trim()).filter(Boolean);
        }
        const data = await client.request<{ pr: PullRequest; autoMerged: boolean }>(
          "PATCH",
          `/api/repos/${slug}/prs/${resolvedNum}`,
          patch,
        );
        printOutput(opts, data, () => {
          console.log(`Updated PR #${data.pr.number}: ${data.pr.title}`);
        });
      },
    );

  prCmd
    .command("checkout <number>")
    .description("Check out a pull request branch locally")
    .action(async (numStr: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ pr: PullRequest }>(
        "GET",
        `/api/repos/${slug}/prs/${numStr}`,
      );
      checkoutBranchFromGitRemote(data.pr.sourceBranch);
      printOutput(opts, { ok: true, pr: data.pr, branch: data.pr.sourceBranch }, () => {
        console.log(`Checked out PR #${data.pr.number} (${data.pr.sourceBranch})`);
      });
    });

  prCmd
    .command("view [number]")
    .action(async (numStr: string | undefined, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const data = await client.request<{
        pr: PullRequest;
        comments: PrComment[];
        reviews: PrReview[];
        gate: MergeGateResult;
      }>("GET", `/api/repos/${slug}/prs/${resolvedNum}`);
      printOutput(opts, data, () => {
        const { pr, gate, comments, reviews } = data;
        console.log(`PR #${pr.number}: ${pr.title} [${pr.status}]`);
        console.log(`  Author: ${pr.authorHandle} (${pr.authorType}${pr.authorOwnerHandle ? `, owner:${pr.authorOwnerHandle}` : ""})`);
        console.log(`  Branches: ${pr.sourceBranch} -> ${pr.targetBranch} | HEAD: ${pr.headSha.slice(0, 7)}`);
        console.log(`  Auto-merge: ${pr.autoMerge} | Assigned agents: ${pr.assignedAgents.join(", ") || "none"}`);
        console.log(`  Merge Gate: ${gate.canMerge ? "READY TO MERGE" : "BLOCKED"}`);
        for (const r of gate.reasons) console.log(`    - ${r}`);
        console.log(`  Reviews (${reviews.length}): ${reviews.map((r) => `${r.actorHandle}:${r.status}`).join(", ") || "none"}`);
        console.log(`  Comments (${comments.length}):`);
        for (const c of comments) {
          const loc = c.filePath ? ` (${c.filePath}${c.line ? `:${c.line}` : ""})` : "";
          const state = c.resolved ? "RESOLVED" : "OPEN";
          console.log(`    [${c.id}] [${c.commentType}${c.severity ? `/${c.severity}` : ""}] [${state}] ${c.authorHandle}${loc}: ${c.body}`);
        }
      });
    });

  prCmd
    .command("diff [number]")
    .option("--include-hidden", "Include files hidden by agent diff-filter rules", false)
    .action(async (numStr: string | undefined, cmdOpts: { includeHidden?: boolean }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const q = cmdOpts.includeHidden ? "?includeHidden=true" : "";
      const data = await client.request<FilteredDiffResponse>(
        "GET",
        `/api/repos/${slug}/prs/${resolvedNum}/diff${q}`,
      );
      printOutput(opts, data, () => {
        console.log(`Diff for PR #${data.prNumber} (viewer: ${data.viewerHandle} [${data.viewerType}])`);
        if (data.hiddenFiles.length > 0) {
          console.log(`Hidden files (${data.hiddenFiles.length}):`);
          for (const hf of data.hiddenFiles) {
            console.log(`  [HIDDEN] ${hf.path} (+${hf.additions}/-${hf.deletions}) — ${hf.reason}`);
          }
        }
        console.log(`Visible files (${data.visibleFiles.length}):`);
        for (const f of data.visibleFiles) {
          console.log(`--- ${f.path} [${f.status}] (+${f.additions}/-${f.deletions}) ---`);
          console.log(f.patch);
        }
      });
    });

  prCmd
    .command("comment [number]")
    .option("--type <type>", "Comment type (blocking, defer_to_next_pr, suggestion, question, agent_finding, or custom)", "suggestion")
    .requiredOption("-b, --body <body>", "Comment text")
    .option("--file <path>", "File path")
    .option("--line <line>", "Line number")
    .option("--severity <sev>", "Severity for agent_finding (info, warning, error)")
    .option("--parent <id>", "Parent comment ID for threaded replies")
    .action(
      async (
        numStr: string | undefined,
        cmdOpts: {
          type: string;
          body: string;
          file?: string;
          line?: string;
          severity?: string;
          parent?: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const resolvedNum = await resolvePrNumber(client, slug, numStr);
        const data = await client.request<{ comment: PrComment }>(
          "POST",
          `/api/repos/${slug}/prs/${resolvedNum}/comments`,
          {
            commentType: cmdOpts.type,
            body: cmdOpts.body,
            filePath: cmdOpts.file ?? null,
            line: cmdOpts.line ? Number.parseInt(cmdOpts.line, 10) : null,
            severity: cmdOpts.severity ?? null,
            parentId: cmdOpts.parent ?? null,
          },
        );
        printOutput(opts, data, () => {
          console.log(`Posted [${data.comment.commentType}] comment ${data.comment.id}`);
          if (data.comment.commentTypeMeta?.agentInstruction) {
            console.log(`  Agent directive: ${data.comment.commentTypeMeta.agentInstruction}`);
          }
        });
      },
    );

  prCmd
    .command("comments [number]")
    .option("--type <type>", "Filter by comment type")
    .option("--unresolved", "Only unresolved comments", false)
    .action(async (numStr: string | undefined, cmdOpts: { type?: string; unresolved?: boolean }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const params = new URLSearchParams();
      if (cmdOpts.type) params.set("type", cmdOpts.type);
      if (cmdOpts.unresolved) params.set("unresolved", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await client.request<{ comments: PrComment[] }>(
        "GET",
        `/api/repos/${slug}/prs/${resolvedNum}/comments${qs}`,
      );
      printOutput(opts, data, () => {
        for (const c of data.comments) {
          const blocks = c.commentTypeMeta?.blocksMerge ? "BLOCKS-MERGE" : "NON-BLOCKING";
          console.log(
            `${c.id} [${c.commentType} | ${blocks}] [${c.resolved ? "RESOLVED" : "OPEN"}] ${c.authorHandle}: ${c.body}`,
          );
          if (c.commentTypeMeta?.agentInstruction) {
            console.log(`   -> ${c.commentTypeMeta.agentInstruction}`);
          }
        }
      });
    });

  prCmd
    .command("resolve <commentId>")
    .action(async (commentId: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const data = await client.request<{ comment: PrComment; autoMerged: boolean; mergedSha?: string }>(
        "POST",
        `/api/comments/${commentId}/resolve`,
      );
      printOutput(opts, data, () => {
        console.log(`Resolved comment ${commentId}${data.autoMerged ? ` -> AUTO-MERGED (${data.mergedSha?.slice(0, 7)})` : ""}`);
      });
    });

  prCmd
    .command("review [number]")
    .option("--status <status>", "approved | changes_requested | commented")
    .option("--approve", "Approve the pull request (gh compatible)", false)
    .option("--request-changes", "Request changes on the pull request (gh compatible)", false)
    .option("--comment", "Leave a review comment (gh compatible)", false)
    .option("-b, --body <body>", "Review summary", "")
    .action(
      async (
        numStr: string | undefined,
        cmdOpts: {
          status?: string;
          approve?: boolean;
          requestChanges?: boolean;
          comment?: boolean;
          body: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const resolvedNum = await resolvePrNumber(client, slug, numStr);
        const status =
          cmdOpts.status ??
          (cmdOpts.approve
            ? "approved"
            : cmdOpts.requestChanges
              ? "changes_requested"
              : cmdOpts.comment
                ? "commented"
                : undefined);
        if (!status) {
          throw new Error("Specify --approve, --request-changes, --comment, or --status <status>.");
        }
        const data = await client.request<{
          review: PrReview;
          gate: MergeGateResult;
          autoMerged: boolean;
          mergedSha?: string;
        }>("POST", `/api/repos/${slug}/prs/${resolvedNum}/reviews`, {
          status,
          body: cmdOpts.body,
        });
        printOutput(opts, data, () => {
          console.log(`Submitted review (${data.review.status}) on PR #${resolvedNum}`);
          if (data.autoMerged) {
            console.log(`AUTO-MERGED PR #${resolvedNum} -> ${data.mergedSha?.slice(0, 7)}`);
          } else {
            console.log(`Gate: ${data.gate.canMerge ? "READY" : "BLOCKED"} ${data.gate.reasons.join("; ")}`);
          }
        });
      },
    );

  const printGate = (resolvedNum: string, g: MergeGateResult) => {
    console.log(`PR #${resolvedNum} Merge Gate: ${g.canMerge ? "PASS" : "BLOCKED"}`);
    console.log(`  CI: ${g.ci.passed ? "PASS" : "FAIL"} (${g.ci.checks.map((c) => `${c.name}=${c.status}`).join(", ") || "none"})`);
    console.log(`  Approvals: ${g.approvals.passed ? "PASS" : "FAIL"} (approved: ${g.approvals.approvedHandles.join(", ") || "none"})`);
    console.log(`  Comments: ${g.comments.passed ? "PASS" : "FAIL"} (blocking: ${g.comments.unresolvedBlockingIds.length}, deferred: ${g.comments.deferredCount})`);
    for (const r of g.reasons) console.log(`  * ${r}`);
  };

  prCmd
    .command("gate [number]")
    .action(async (numStr: string | undefined, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const data = await client.request<{ gate: MergeGateResult }>(
        "GET",
        `/api/repos/${slug}/prs/${resolvedNum}/gate`,
      );
      printOutput(opts, data, () => printGate(resolvedNum, data.gate));
    });

  prCmd
    .command("checks [number]")
    .description("Show CI checks and merge gate status (gh compatible)")
    .option("--sync", "Fetch latest CI checks from upstream forge before printing", false)
    .action(async (numStr: string | undefined, cmdOpts: { sync?: boolean }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const data = cmdOpts.sync
        ? await client.request<{ gate: MergeGateResult }>(
            "POST",
            `/api/repos/${slug}/prs/${resolvedNum}/ci`,
            {},
          )
        : await client.request<{ gate: MergeGateResult }>(
            "GET",
            `/api/repos/${slug}/prs/${resolvedNum}/gate`,
          );
      printOutput(opts, data, () => printGate(resolvedNum, data.gate));
    });

  prCmd
    .command("ci [number]")
    .option("--check <items...>", "Report checks as name:status (e.g. unit-tests:passed)")
    .action(async (numStr: string | undefined, cmdOpts: { check?: string[] }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const body = cmdOpts.check
        ? {
            checks: cmdOpts.check.map((item) => {
              const [name, status = "passed"] = item.split(":");
              return { name, status, updatedAt: new Date().toISOString() };
            }),
          }
        : {};
      const data = await client.request<{ pr: PullRequest; gate: MergeGateResult; autoMerged: boolean }>(
        "POST",
        `/api/repos/${slug}/prs/${resolvedNum}/ci`,
        body,
      );
      printOutput(opts, data, () => {
        console.log(`Updated CI on PR #${resolvedNum} -> gate=${data.gate.canMerge ? "PASS" : "BLOCKED"}${data.autoMerged ? " (AUTO-MERGED)" : ""}`);
      });
    });

  prCmd
    .command("merge [number]")
    .option("--force", "Admin-only force merge bypassing gates", false)
    .option("--method <method>", "Merge method: merge | squash | rebase")
    .option("--squash", "Use squash merge (gh compatible)", false)
    .option("--merge", "Use merge commit (gh compatible)", false)
    .option("--rebase", "Use rebase merge (gh compatible)", false)
    .option("--auto", "Enable auto-merge instead of merging immediately (gh compatible)", false)
    .action(
      async (
        numStr: string | undefined,
        cmdOpts: {
          force?: boolean;
          method?: string;
          squash?: boolean;
          merge?: boolean;
          rebase?: boolean;
          auto?: boolean;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const resolvedNum = await resolvePrNumber(client, slug, numStr);
        if (cmdOpts.auto) {
          const data = await client.request<{ pr: PullRequest; autoMerged: boolean; mergedSha?: string }>(
            "PATCH",
            `/api/repos/${slug}/prs/${resolvedNum}`,
            { autoMerge: true },
          );
          printOutput(opts, data, () => {
            console.log(
              data.autoMerged
                ? `Auto-merged PR #${resolvedNum} -> ${data.mergedSha}`
                : `Enabled auto-merge on PR #${resolvedNum}`,
            );
          });
          return;
        }
        const mergeMethod =
          cmdOpts.method ??
          (cmdOpts.squash ? "squash" : cmdOpts.merge ? "merge" : cmdOpts.rebase ? "rebase" : undefined);
        const data = await client.request<{ pr: PullRequest; mergedSha: string }>(
          "POST",
          `/api/repos/${slug}/prs/${resolvedNum}/merge`,
          { force: cmdOpts.force, mergeMethod },
        );
        printOutput(opts, data, () => {
          console.log(`Merged PR #${resolvedNum} -> ${data.mergedSha}`);
        });
      },
    );

  prCmd
    .command("close [number]")
    .description("Close an open pull request")
    .action(async (numStr: string | undefined, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const data = await client.request<{ pr: PullRequest }>(
        "POST",
        `/api/repos/${slug}/prs/${resolvedNum}/close`,
      );
      printOutput(opts, data, () => {
        console.log(`Closed PR #${data.pr.number}: ${data.pr.title}`);
      });
    });

  prCmd
    .command("reopen [number]")
    .description("Reopen a closed pull request")
    .action(async (numStr: string | undefined, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const resolvedNum = await resolvePrNumber(client, slug, numStr);
      const data = await client.request<{ pr: PullRequest }>(
        "POST",
        `/api/repos/${slug}/prs/${resolvedNum}/reopen`,
      );
      printOutput(opts, data, () => {
        console.log(`Reopened PR #${data.pr.number}: ${data.pr.title}`);
      });
    });

  // ---- agent ----
  const agentCmd = program.command("agent").description("Manage agent bot identities and invoke agents");

  agentCmd.command("list").action(async (_opts, cmd: Command) => {
    const { client, opts } = getClient(cmd);
    const data = await client.request<{ actors: Actor[] }>("GET", "/api/actors?type=agent");
    printOutput(opts, data, () => {
      for (const a of data.actors) {
        console.log(`${a.handle} (${a.displayName}) branches=[${a.allowedBranchPatterns.join(",")}] approve=${a.canApprove} merge=${a.canMerge}`);
      }
    });
  });

  agentCmd
    .command("create")
    .requiredOption("--handle <handle>", "Unique agent handle")
    .requiredOption("--name <displayName>", "Agent display name")
    .option("--branches <globs>", "Comma-separated allowed branch patterns", "agent/**,feature/**")
    .option("--can-merge", "Allow agent to execute merges", false)
    .option("--webhook <url>", "Direct webhook URL for invoking this agent")
    .action(
      async (
        cmdOpts: { handle: string; name: string; branches: string; canMerge?: boolean; webhook?: string },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const data = await client.request<{ actor: Actor; token: string }>("POST", "/api/actors", {
          handle: cmdOpts.handle,
          displayName: cmdOpts.name,
          type: "agent",
          role: "agent",
          allowedBranchPatterns: cmdOpts.branches.split(",").map((s) => s.trim()),
          canMerge: cmdOpts.canMerge,
          canApprove: true,
          agentWebhookUrl: cmdOpts.webhook ?? null,
        });
        printOutput(opts, data, () => {
          console.log(`Created agent '${data.actor.handle}'`);
          console.log(`  Bot token (save this): ${data.token}`);
        });
      },
    );

  agentCmd
    .command("invoke")
    .requiredOption("--pr <number>", "PR number")
    .requiredOption("--agent <handle>", "Target agent handle")
    .option("--comment <id>", "Optional comment ID to address")
    .option("--prompt <text>", "Instruction for the agent", "")
    .action(
      async (
        cmdOpts: { pr: string; agent: string; comment?: string; prompt: string },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const data = await client.request<{ ok: boolean; deliveries: unknown[] }>(
          "POST",
          `/api/repos/${slug}/prs/${cmdOpts.pr}/invoke-agent`,
          {
            agentHandle: cmdOpts.agent,
            commentId: cmdOpts.comment ?? null,
            prompt: cmdOpts.prompt,
          },
        );
        printOutput(opts, data, () => {
          console.log(`Invoked agent '${cmdOpts.agent}' on PR #${cmdOpts.pr} (${data.deliveries.length} webhook delivery(ies))`);
        });
      },
    );

  return program;
}

const isDirectRun =
  process.argv[1]?.endsWith("/dist/index.js") ||
  process.argv[1]?.endsWith("/bin/agit") ||
  process.argv[1]?.endsWith("/src/index.ts");

if (isDirectRun) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      if (err instanceof AgitApiError) {
        console.error(`Error (${err.status}): ${err.message}`);
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    });
}
