import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMENT_TYPES,
  DEFAULT_MERGE_POLICY,
  type CommentTypeDefinition,
  type DiffFile,
  type DiffFilterRule,
  type PrComment,
  type PrReview,
  type PullRequest,
} from "@agentic-git/shared";
import { evaluateMergeGate, filterDiffFiles } from "./policy-engine.js";

function makePr(overrides?: Partial<PullRequest>): PullRequest {
  return {
    id: "pr_1",
    number: 1,
    repoId: "rep_1",
    repoSlug: "acme/app",
    title: "Add billing engine",
    description: "",
    sourceBranch: "agent/billing",
    targetBranch: "main",
    headSha: "sha_head_1",
    status: "open",
    authorActorId: "act_coder",
    authorHandle: "coder-agent",
    authorType: "agent",
    authorOwnerHandle: "alice",
    upstreamPrId: "42",
    upstreamPrUrl: "https://example.test/pr/42",
    autoMerge: true,
    assignedAgents: ["test-review-agent", "security-agent"],
    ciChecks: [{ name: "ci/build", status: "passed", updatedAt: "2026-01-01T00:00:00Z" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeReview(actorHandle: string, status: PrReview["status"], commitSha = "sha_head_1"): PrReview {
  return {
    id: `rev_${actorHandle}_${status}`,
    prId: "pr_1",
    actorId: `act_${actorHandle}`,
    actorHandle,
    actorType: "agent",
    status,
    body: "",
    commitSha,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeComment(overrides: Partial<PrComment>): PrComment {
  return {
    id: "cmt_1",
    prId: "pr_1",
    authorActorId: "act_rev",
    authorHandle: "security-agent",
    authorType: "agent",
    commentType: "blocking",
    body: "Fix SQL injection",
    metadata: {},
    resolved: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("evaluateMergeGate", () => {
  it("enforces requiredApprovers (A and B must both approve)", () => {
    const policy = {
      ...DEFAULT_MERGE_POLICY,
      minApprovals: 2,
      requiredApprovers: ["agent-a", "agent-b"],
    };

    const onlyA = evaluateMergeGate({
      pr: makePr(),
      policy,
      reviews: [makeReview("agent-a", "approved")],
      comments: [],
      commentTypes: BUILTIN_COMMENT_TYPES,
    });
    expect(onlyA.canMerge).toBe(false);
    expect(onlyA.approvals.missingRequiredApprovers).toEqual(["agent-b"]);

    const both = evaluateMergeGate({
      pr: makePr(),
      policy,
      reviews: [makeReview("agent-a", "approved"), makeReview("agent-b", "approved")],
      comments: [],
      commentTypes: BUILTIN_COMMENT_TYPES,
    });
    expect(both.canMerge).toBe(true);
    expect(both.reasons).toEqual([]);
  });

  it("blocks on unresolved 'blocking' comments and error findings, but NOT on 'defer_to_next_pr'", () => {
    const customTypes: CommentTypeDefinition[] = [
      ...BUILTIN_COMMENT_TYPES,
      {
        key: "security_blocker",
        label: "Security Blocker",
        description: "Must fix before merge",
        blocksMerge: true,
        agentInstruction: "Fix immediately",
        color: "#b91c1c",
        builtin: false,
      },
    ];
    const policy = { ...DEFAULT_MERGE_POLICY, minApprovals: 1 };
    const reviews = [makeReview("agent-a", "approved")];

    const withDeferOnly = evaluateMergeGate({
      pr: makePr(),
      policy,
      reviews,
      comments: [
        makeComment({ id: "cmt_defer", commentType: "defer_to_next_pr", body: "Handle in follow-up PR" }),
        makeComment({ id: "cmt_warn", commentType: "agent_finding", severity: "warning", body: "Minor style" }),
      ],
      commentTypes: customTypes,
    });
    expect(withDeferOnly.canMerge).toBe(true);
    expect(withDeferOnly.comments.deferredCount).toBe(1);

    const withCustomBlocker = evaluateMergeGate({
      pr: makePr(),
      policy,
      reviews,
      comments: [
        makeComment({ id: "cmt_sec", commentType: "security_blocker", body: "Validate JWT signature" }),
        makeComment({ id: "cmt_err", commentType: "agent_finding", severity: "error", body: "Null deref" }),
      ],
      commentTypes: customTypes,
    });
    expect(withCustomBlocker.canMerge).toBe(false);
    expect(withCustomBlocker.comments.unresolvedBlockingIds).toEqual(["cmt_sec"]);
    expect(withCustomBlocker.comments.unresolvedErrorFindingIds).toEqual(["cmt_err"]);
  });

  it("invalidates stale approvals after new push when invalidateApprovalsOnPush is true", () => {
    const policy = {
      ...DEFAULT_MERGE_POLICY,
      minApprovals: 1,
      invalidateApprovalsOnPush: true,
    };
    const res = evaluateMergeGate({
      pr: makePr({ headSha: "sha_new" }),
      policy,
      reviews: [makeReview("agent-a", "approved", "sha_old")],
      comments: [],
      commentTypes: BUILTIN_COMMENT_TYPES,
    });
    expect(res.canMerge).toBe(false);
    expect(res.approvals.approvedHandles).toEqual([]);
  });
});

describe("filterDiffFiles", () => {
  const files: DiffFile[] = [
    { path: "src/billing.ts", status: "modified", additions: 20, deletions: 2, patch: "+code" },
    { path: "src/billing.test.ts", status: "added", additions: 50, deletions: 0, patch: "+test" },
    { path: "src/__tests__/edge.spec.ts", status: "added", additions: 30, deletions: 0, patch: "+spec" },
  ];

  const rules: DiffFilterRule[] = [
    {
      id: "hide-tests",
      name: "Hide tests reviewed by test-review-agent",
      description: "Humans skip test diffs once test-review-agent approves",
      filePatterns: ["**/*.test.{ts,tsx,js}", "**/__tests__/**"],
      hideForActorTypes: ["human"],
      hideForHandles: [],
      whenAgentAssigned: "test-review-agent",
      whenAgentApproved: "test-review-agent",
      enabled: true,
    },
  ];

  it("shows test files to humans until test-review-agent approves, then hides them", () => {
    const beforeApproval = filterDiffFiles({
      pr: makePr(),
      files,
      rules,
      viewer: { handle: "alice", type: "human" },
      reviews: [],
    });
    expect(beforeApproval.visibleFiles.map((f) => f.path)).toEqual([
      "src/billing.ts",
      "src/billing.test.ts",
      "src/__tests__/edge.spec.ts",
    ]);
    expect(beforeApproval.hiddenFiles).toHaveLength(0);

    const afterApproval = filterDiffFiles({
      pr: makePr(),
      files,
      rules,
      viewer: { handle: "alice", type: "human" },
      reviews: [makeReview("test-review-agent", "approved")],
    });
    expect(afterApproval.visibleFiles.map((f) => f.path)).toEqual(["src/billing.ts"]);
    expect(afterApproval.hiddenFiles.map((f) => f.path)).toEqual([
      "src/billing.test.ts",
      "src/__tests__/edge.spec.ts",
    ]);
    expect(afterApproval.hiddenFiles[0].coveredByAgent).toBe("test-review-agent");

    // Agent viewer still sees all files!
    const forAgent = filterDiffFiles({
      pr: makePr(),
      files,
      rules,
      viewer: { handle: "test-review-agent", type: "agent" },
      reviews: [makeReview("test-review-agent", "approved")],
    });
    expect(forAgent.visibleFiles).toHaveLength(3);
    expect(forAgent.hiddenFiles).toHaveLength(0);

    // Human can opt in with includeHidden=true
    const withOverride = filterDiffFiles({
      pr: makePr(),
      files,
      rules,
      viewer: { handle: "alice", type: "human" },
      reviews: [makeReview("test-review-agent", "approved")],
      includeHidden: true,
    });
    expect(withOverride.visibleFiles).toHaveLength(3);
    expect(withOverride.hiddenFiles).toHaveLength(2);
  });
});
