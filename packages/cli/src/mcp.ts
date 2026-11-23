import readline from "node:readline";
import type { AgitClient } from "./client.js";
import { inferRepoSlugFromGit } from "./config.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: "agit_whoami",
    description: "Return the authenticated human or agent actor identity and branch permissions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agit_pr_list",
    description: "List pull requests and their merge gate status in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "org/repo slug (optional; inferred from git remote)" },
        status: { type: "string", enum: ["open", "merged", "closed"] },
      },
    },
  },
  {
    name: "agit_pr_view",
    description: "View full details, typed comments, reviews, and merge gate for a pull request.",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
      },
    },
  },
  {
    name: "agit_pr_create",
    description: "Create a new pull request (and upstream shadow PR) for a pushed branch.",
    inputSchema: {
      type: "object",
      required: ["title", "sourceBranch"],
      properties: {
        repo: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        sourceBranch: { type: "string" },
        targetBranch: { type: "string" },
        autoMerge: { type: "boolean" },
        assignedAgents: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "agit_pr_diff",
    description: "Fetch the agent-aware filtered diff for a pull request.",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        includeHidden: { type: "boolean" },
      },
    },
  },
  {
    name: "agit_pr_comments",
    description:
      "Fetch typed PR comments along with explicit blocksMerge flags and agentInstruction directives.",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        type: { type: "string" },
        unresolvedOnly: { type: "boolean" },
      },
    },
  },
  {
    name: "agit_pr_comment",
    description:
      "Post a typed comment (blocking, defer_to_next_pr, suggestion, question, agent_finding, or custom) on a PR.",
    inputSchema: {
      type: "object",
      required: ["prNumber", "body"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        commentType: { type: "string", default: "suggestion" },
        body: { type: "string" },
        filePath: { type: "string" },
        line: { type: "number" },
        severity: { type: "string", enum: ["info", "warning", "error"] },
        parentId: { type: "string" },
      },
    },
  },
  {
    name: "agit_pr_resolve",
    description: "Mark a PR comment thread resolved (triggers auto-merge if all gates pass).",
    inputSchema: {
      type: "object",
      required: ["commentId"],
      properties: {
        commentId: { type: "string" },
      },
    },
  },
  {
    name: "agit_pr_review",
    description: "Submit an approval, changes_requested, or commented review on a PR.",
    inputSchema: {
      type: "object",
      required: ["prNumber", "status"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        status: { type: "string", enum: ["approved", "changes_requested", "commented"] },
        body: { type: "string" },
      },
    },
  },
  {
    name: "agit_pr_gate",
    description: "Evaluate the live merge gate (CI checks, approvals, blocking comments) for a PR.",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
      },
    },
  },
  {
    name: "agit_pr_merge",
    description: "Merge a pull request once all merge gates pass.",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
      },
    },
  },
  {
    name: "agit_pr_close",
    description: "Close an open pull request (and its upstream shadow PR).",
    inputSchema: {
      type: "object",
      required: ["prNumber"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
      },
    },
  },
  {
    name: "agit_pr_followups",
    description: "Return all defer_to_next_pr follow-up items and a ready-to-use Markdown checklist.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number", description: "Omit for repo-wide deferred follow-ups" },
      },
    },
  },
  {
    name: "agit_pr_fix_blocking",
    description:
      "Bundle all unresolved blocking comments, error findings, and failing CI checks and dispatch to an agent.",
    inputSchema: {
      type: "object",
      required: ["prNumber", "agentHandle"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: "number" },
        agentHandle: { type: "string" },
        prompt: { type: "string" },
      },
    },
  },
];

function resolveToolRepo(args: Record<string, unknown>, defaultRepo?: string): string {
  const explicit = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : null;
  const slug = explicit ?? defaultRepo ?? process.env.AGIT_REPO ?? inferRepoSlugFromGit();
  if (!slug) {
    throw new Error("Could not infer repo slug. Pass `repo: \"org/repo\"` or set AGIT_REPO.");
  }
  return slug;
}

async function callTool(
  client: AgitClient,
  name: string,
  args: Record<string, unknown>,
  defaultRepo?: string,
): Promise<unknown> {
  switch (name) {
    case "agit_whoami":
      return client.request("GET", "/api/me");
    case "agit_pr_list": {
      const slug = resolveToolRepo(args, defaultRepo);
      const q = typeof args.status === "string" ? `?status=${encodeURIComponent(args.status)}` : "";
      return client.request("GET", `/api/repos/${slug}/prs${q}`);
    }
    case "agit_pr_view": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("GET", `/api/repos/${slug}/prs/${args.prNumber}`);
    }
    case "agit_pr_create": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs`, {
        title: args.title,
        description: args.description ?? "",
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        autoMerge: args.autoMerge,
        assignedAgents: args.assignedAgents ?? [],
      });
    }
    case "agit_pr_diff": {
      const slug = resolveToolRepo(args, defaultRepo);
      const q = args.includeHidden ? "?includeHidden=true" : "";
      return client.request("GET", `/api/repos/${slug}/prs/${args.prNumber}/diff${q}`);
    }
    case "agit_pr_comments": {
      const slug = resolveToolRepo(args, defaultRepo);
      const params = new URLSearchParams();
      if (typeof args.type === "string") params.set("type", args.type);
      if (args.unresolvedOnly) params.set("unresolved", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";
      return client.request("GET", `/api/repos/${slug}/prs/${args.prNumber}/comments${qs}`);
    }
    case "agit_pr_comment": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs/${args.prNumber}/comments`, {
        commentType: args.commentType ?? "suggestion",
        body: args.body,
        filePath: args.filePath ?? null,
        line: typeof args.line === "number" ? args.line : null,
        severity: args.severity ?? null,
        parentId: args.parentId ?? null,
      });
    }
    case "agit_pr_resolve":
      return client.request("POST", `/api/comments/${args.commentId}/resolve`);
    case "agit_pr_review": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs/${args.prNumber}/reviews`, {
        status: args.status,
        body: args.body ?? "",
      });
    }
    case "agit_pr_gate": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("GET", `/api/repos/${slug}/prs/${args.prNumber}/gate`);
    }
    case "agit_pr_merge": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs/${args.prNumber}/merge`, {
        mergeMethod: args.mergeMethod,
      });
    }
    case "agit_pr_close": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs/${args.prNumber}/close`);
    }
    case "agit_pr_followups": {
      const slug = resolveToolRepo(args, defaultRepo);
      if (args.prNumber !== undefined && args.prNumber !== null) {
        return client.request("GET", `/api/repos/${slug}/prs/${args.prNumber}/followups`);
      }
      return client.request("GET", `/api/repos/${slug}/followups`);
    }
    case "agit_pr_fix_blocking": {
      const slug = resolveToolRepo(args, defaultRepo);
      return client.request("POST", `/api/repos/${slug}/prs/${args.prNumber}/fix-blocking`, {
        agentHandle: args.agentHandle,
        prompt: args.prompt ?? "",
      });
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

export async function startMcpServer(client: AgitClient, defaultRepo?: string): Promise<void> {
  const writeMsg = (msg: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeMsg({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    // Notifications without an id do not expect a response
    if (req.id === undefined) {
      continue;
    }

    try {
      if (req.method === "initialize") {
        writeMsg({
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentic-git", version: "0.2.0" },
          },
        });
      } else if (req.method === "ping") {
        writeMsg({ id: req.id, result: {} });
      } else if (req.method === "tools/list") {
        writeMsg({ id: req.id, result: { tools: TOOLS } });
      } else if (req.method === "tools/call") {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!params.name) {
          writeMsg({ id: req.id, error: { code: -32602, message: "Missing tool name" } });
          continue;
        }
        try {
          const data = await callTool(client, params.name, params.arguments ?? {}, defaultRepo);
          writeMsg({
            id: req.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            },
          });
        } catch (err) {
          writeMsg({
            id: req.id,
            result: {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            },
          });
        }
      } else {
        writeMsg({
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
    } catch (err) {
      writeMsg({
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
