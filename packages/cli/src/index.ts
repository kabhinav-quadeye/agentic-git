#!/usr/bin/env node
import { Command } from "commander";
import type {
  Actor,
  FilteredDiffResponse,
  MergeGateResult,
  PrComment,
  PrReview,
  PullRequest,
  PushAuditEntry,
  Repo,
} from "@agentic-git/shared";
import { AgitApiError, AgitClient } from "./client.js";
import {
  inferCurrentBranch,
  inferRepoSlugFromGit,
  loadConfig,
  saveConfig,
} from "./config.js";

interface GlobalOpts {
  server?: string;
  token?: string;
  repo?: string;
  json?: boolean;
}

function getClient(cmd: Command): { client: AgitClient; opts: GlobalOpts } {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  const cfg = loadConfig({ server: opts.server, token: opts.token });
  return { client: new AgitClient(cfg), opts };
}

function resolveRepo(opts: GlobalOpts): string {
  const slug = opts.repo ?? process.env.AGIT_REPO ?? inferRepoSlugFromGit();
  if (!slug) {
    throw new Error(
      "Could not infer repository slug. Pass --repo <org/repo> or run inside a git repo cloned from agentic-git.",
    );
  }
  return slug;
}

function printOutput(opts: GlobalOpts, data: unknown, humanFn: () => void): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("agit")
    .description("Agent-native Git & PR workflow CLI (companion to agentic-git)")
    .version("0.1.0")
    .option("-s, --server <url>", "agentic-git server URL (or AGIT_URL)")
    .option("-t, --token <token>", "actor or bot auth token (or AGIT_TOKEN)")
    .option("-r, --repo <org/repo>", "repository slug (auto-detected from git remote)")
    .option("--json", "output structured JSON (ideal for agents)", false);

  // ---- config ----
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

  // ---- repo ----
  const repoCmd = program.command("repo").description("Inspect repositories and push audit trails");
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

  // ---- pr ----
  const prCmd = program.command("pr").description("Pull requests, agent-filtered diffs, typed comments & merge gates");

  prCmd
    .command("list")
    .option("--status <status>", "Filter by status: open, merged, closed")
    .action(async (cmdOpts: { status?: string }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const q = cmdOpts.status ? `?status=${encodeURIComponent(cmdOpts.status)}` : "";
      const data = await client.request<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
        "GET",
        `/api/repos/${slug}/prs${q}`,
      );
      printOutput(opts, data, () => {
        if (data.prs.length === 0) {
          console.log("No pull requests found.");
          return;
        }
        for (const pr of data.prs) {
          const gateStr = pr.gate.canMerge ? "READY" : "BLOCKED";
          console.log(
            `#${pr.number} [${pr.status.toUpperCase()} | ${gateStr}] ${pr.title} (${pr.sourceBranch} -> ${pr.targetBranch}) by ${pr.authorHandle}`,
          );
        }
      });
    });

  prCmd
    .command("create")
    .requiredOption("--title <title>", "PR title")
    .option("--body <description>", "PR description", "")
    .option("--head <branch>", "Source branch (defaults to current git branch)")
    .option("--base <branch>", "Target branch (defaults to repo default branch)")
    .option("--auto-merge", "Enable automatic merge once all merge gates pass", false)
    .option("--assign-agent <handles>", "Comma-separated agent handles assigned to this PR")
    .action(
      async (
        cmdOpts: {
          title: string;
          body: string;
          head?: string;
          base?: string;
          autoMerge?: boolean;
          assignAgent?: string;
        },
        cmd: Command,
      ) => {
        const { client, opts } = getClient(cmd);
        const slug = resolveRepo(opts);
        const sourceBranch = cmdOpts.head ?? inferCurrentBranch();
        if (!sourceBranch) {
          throw new Error("Could not detect current branch; pass --head <branch>");
        }
        const assignedAgents = cmdOpts.assignAgent
          ? cmdOpts.assignAgent
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        const data = await client.request<{ pr: PullRequest }>("POST", `/api/repos/${slug}/prs`, {
          title: cmdOpts.title,
          description: cmdOpts.body,
          sourceBranch,
          targetBranch: cmdOpts.base,
          autoMerge: cmdOpts.autoMerge,
          assignedAgents,
        });
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
    .command("view <number>")
    .action(async (numStr: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{
        pr: PullRequest;
        comments: PrComment[];
        reviews: PrReview[];
        gate: MergeGateResult;
      }>("GET", `/api/repos/${slug}/prs/${numStr}`);
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
    .command("diff <number>")
    .option("--include-hidden", "Include files hidden by agent diff-filter rules", false)
    .action(async (numStr: string, cmdOpts: { includeHidden?: boolean }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const q = cmdOpts.includeHidden ? "?includeHidden=true" : "";
      const data = await client.request<FilteredDiffResponse>(
        "GET",
        `/api/repos/${slug}/prs/${numStr}/diff${q}`,
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
    .command("comment <number>")
    .requiredOption("--type <type>", "Comment type (blocking, defer_to_next_pr, suggestion, question, agent_finding, or custom)")
    .requiredOption("--body <body>", "Comment text")
    .option("--file <path>", "File path")
    .option("--line <line>", "Line number")
    .option("--severity <sev>", "Severity for agent_finding (info, warning, error)")
    .option("--parent <id>", "Parent comment ID for threaded replies")
    .action(
      async (
        numStr: string,
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
        const data = await client.request<{ comment: PrComment }>(
          "POST",
          `/api/repos/${slug}/prs/${numStr}/comments`,
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
    .command("comments <number>")
    .option("--type <type>", "Filter by comment type")
    .option("--unresolved", "Only unresolved comments", false)
    .action(async (numStr: string, cmdOpts: { type?: string; unresolved?: boolean }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const params = new URLSearchParams();
      if (cmdOpts.type) params.set("type", cmdOpts.type);
      if (cmdOpts.unresolved) params.set("unresolved", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await client.request<{ comments: PrComment[] }>(
        "GET",
        `/api/repos/${slug}/prs/${numStr}/comments${qs}`,
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
    .command("review <number>")
    .requiredOption("--status <status>", "approved | changes_requested | commented")
    .option("--body <body>", "Review summary", "")
    .action(async (numStr: string, cmdOpts: { status: string; body: string }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{
        review: PrReview;
        gate: MergeGateResult;
        autoMerged: boolean;
        mergedSha?: string;
      }>("POST", `/api/repos/${slug}/prs/${numStr}/reviews`, {
        status: cmdOpts.status,
        body: cmdOpts.body,
      });
      printOutput(opts, data, () => {
        console.log(`Submitted review (${data.review.status}) on PR #${numStr}`);
        if (data.autoMerged) {
          console.log(`AUTO-MERGED PR #${numStr} -> ${data.mergedSha?.slice(0, 7)}`);
        } else {
          console.log(`Gate: ${data.gate.canMerge ? "READY" : "BLOCKED"} ${data.gate.reasons.join("; ")}`);
        }
      });
    });

  prCmd
    .command("gate <number>")
    .action(async (numStr: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ gate: MergeGateResult }>(
        "GET",
        `/api/repos/${slug}/prs/${numStr}/gate`,
      );
      printOutput(opts, data, () => {
        const g = data.gate;
        console.log(`PR #${numStr} Merge Gate: ${g.canMerge ? "PASS" : "BLOCKED"}`);
        console.log(`  CI: ${g.ci.passed ? "PASS" : "FAIL"} (${g.ci.checks.map((c) => `${c.name}=${c.status}`).join(", ") || "none"})`);
        console.log(`  Approvals: ${g.approvals.passed ? "PASS" : "FAIL"} (approved: ${g.approvals.approvedHandles.join(", ") || "none"})`);
        console.log(`  Comments: ${g.comments.passed ? "PASS" : "FAIL"} (blocking: ${g.comments.unresolvedBlockingIds.length}, deferred: ${g.comments.deferredCount})`);
        for (const r of g.reasons) console.log(`  * ${r}`);
      });
    });

  prCmd
    .command("ci <number>")
    .option("--check <items...>", "Report checks as name:status (e.g. unit-tests:passed)")
    .action(async (numStr: string, cmdOpts: { check?: string[] }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
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
        `/api/repos/${slug}/prs/${numStr}/ci`,
        body,
      );
      printOutput(opts, data, () => {
        console.log(`Updated CI on PR #${numStr} -> gate=${data.gate.canMerge ? "PASS" : "BLOCKED"}${data.autoMerged ? " (AUTO-MERGED)" : ""}`);
      });
    });

  prCmd
    .command("merge <number>")
    .option("--force", "Admin-only force merge bypassing gates", false)
    .option("--method <method>", "Merge method: merge | squash | rebase")
    .action(async (numStr: string, cmdOpts: { force?: boolean; method?: string }, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ pr: PullRequest; mergedSha: string }>(
        "POST",
        `/api/repos/${slug}/prs/${numStr}/merge`,
        { force: cmdOpts.force, mergeMethod: cmdOpts.method },
      );
      printOutput(opts, data, () => {
        console.log(`Merged PR #${numStr} -> ${data.mergedSha}`);
      });
    });

  prCmd
    .command("close <number>")
    .description("Close an open pull request")
    .action(async (numStr: string, _opts, cmd: Command) => {
      const { client, opts } = getClient(cmd);
      const slug = resolveRepo(opts);
      const data = await client.request<{ pr: PullRequest }>(
        "POST",
        `/api/repos/${slug}/prs/${numStr}/close`,
      );
      printOutput(opts, data, () => {
        console.log(`Closed PR #${data.pr.number}: ${data.pr.title}`);
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
