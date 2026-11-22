import {
  BUILTIN_COMMENT_TYPES,
  matchAnyGlob,
  type Actor,
  type CiCheck,
  type CommentTypeDefinition,
  type DiffFile,
  type DiffFilterRule,
  type FilteredDiffResponse,
  type HiddenDiffFile,
  type MergeGateResult,
  type MergePolicy,
  type PrComment,
  type PrReview,
  type PullRequest,
} from "@agentic-git/shared";

/**
 * Computes the latest effective review status per actor handle.
 * If invalidateApprovalsOnPush is enabled, approvals from older commits are ignored.
 */
export function getEffectiveReviewsByActor(
  reviews: PrReview[],
  headSha: string,
  invalidateApprovalsOnPush: boolean,
): Map<string, PrReview> {
  const latest = new Map<string, PrReview>();
  for (const rev of reviews) {
    if (invalidateApprovalsOnPush && rev.status === "approved" && rev.commitSha !== headSha) {
      continue;
    }
    latest.set(rev.actorHandle, rev);
  }
  return latest;
}

export function evaluateMergeGate(params: {
  pr: PullRequest;
  policy: MergePolicy;
  reviews: PrReview[];
  comments: PrComment[];
  commentTypes: CommentTypeDefinition[];
}): MergeGateResult {
  const { pr, policy, reviews, comments, commentTypes } = params;
  const reasons: string[] = [];

  // 1. CI Checks evaluation
  const checks = pr.ciChecks;
  const checkByName = new Map<string, CiCheck>();
  for (const ch of checks) {
    checkByName.set(ch.name, ch);
  }

  const missingChecks: string[] = [];
  let ciPassed = true;

  if (policy.requireCiPassed) {
    if (policy.requiredChecks.length > 0) {
      for (const reqName of policy.requiredChecks) {
        const found = checkByName.get(reqName);
        if (!found) {
          missingChecks.push(reqName);
          ciPassed = false;
        } else if (found.status !== "passed") {
          ciPassed = false;
          reasons.push(`Required CI check '${reqName}' is ${found.status}`);
        }
      }
      if (missingChecks.length > 0) {
        reasons.push(`Missing required CI checks: ${missingChecks.join(", ")}`);
      }
    } else {
      if (checks.length === 0) {
        ciPassed = false;
        reasons.push("CI is required, but no CI checks have reported yet");
      } else {
        const nonPassing = checks.filter((c) => c.status !== "passed");
        if (nonPassing.length > 0) {
          ciPassed = false;
          reasons.push(
            `CI checks not passing: ${nonPassing.map((c) => `${c.name} (${c.status})`).join(", ")}`,
          );
        }
      }
    }
  }

  // 2. Approvals evaluation
  const effectiveReviews = getEffectiveReviewsByActor(
    reviews,
    pr.headSha,
    policy.invalidateApprovalsOnPush,
  );
  const approvedHandles: string[] = [];
  const changesRequestedHandles: string[] = [];

  for (const [handle, rev] of effectiveReviews.entries()) {
    if (rev.status === "approved") {
      if (!policy.allowSelfApproval && handle === pr.authorHandle) {
        continue;
      }
      approvedHandles.push(handle);
    } else if (rev.status === "changes_requested") {
      changesRequestedHandles.push(handle);
    }
  }

  const approvedSet = new Set(approvedHandles);
  const missingRequiredApprovers = policy.requiredApprovers.filter((h) => !approvedSet.has(h));
  const unsatisfiedGroups = policy.anyOfApprovalGroups.filter(
    (group) => !group.some((h) => approvedSet.has(h)),
  );

  let approvalsPassed = true;
  if (changesRequestedHandles.length > 0) {
    approvalsPassed = false;
    reasons.push(`Changes requested by: ${changesRequestedHandles.join(", ")}`);
  }
  if (approvedHandles.length < policy.minApprovals) {
    approvalsPassed = false;
    reasons.push(`Need at least ${policy.minApprovals} approval(s), currently ${approvedHandles.length}`);
  }
  if (missingRequiredApprovers.length > 0) {
    approvalsPassed = false;
    reasons.push(`Missing required approver(s): ${missingRequiredApprovers.join(", ")}`);
  }
  for (const grp of unsatisfiedGroups) {
    approvalsPassed = false;
    reasons.push(`Need approval from at least one of: [${grp.join(", ")}]`);
  }

  // 3. Typed Comments evaluation
  const typeMap = new Map<string, CommentTypeDefinition>();
  for (const ct of BUILTIN_COMMENT_TYPES) typeMap.set(ct.key, ct);
  for (const ct of commentTypes) typeMap.set(ct.key, ct);

  const unresolvedBlockingIds: string[] = [];
  const unresolvedErrorFindingIds: string[] = [];
  let deferredCount = 0;

  for (const c of comments) {
    if (c.commentType === "defer_to_next_pr") {
      deferredCount += 1;
    }
    if (c.resolved) continue;

    const def = typeMap.get(c.commentType);
    if (def?.blocksMerge) {
      unresolvedBlockingIds.push(c.id);
    } else if (
      policy.blockOnErrorFindings &&
      c.commentType === "agent_finding" &&
      c.severity === "error"
    ) {
      unresolvedErrorFindingIds.push(c.id);
    }
  }

  const commentsPassed =
    unresolvedBlockingIds.length === 0 && unresolvedErrorFindingIds.length === 0;
  if (unresolvedBlockingIds.length > 0) {
    reasons.push(`${unresolvedBlockingIds.length} unresolved blocking comment(s)`);
  }
  if (unresolvedErrorFindingIds.length > 0) {
    reasons.push(`${unresolvedErrorFindingIds.length} unresolved error-severity agent finding(s)`);
  }

  const canMerge = pr.status === "open" && ciPassed && approvalsPassed && commentsPassed;
  if (pr.status !== "open") {
    reasons.unshift(`PR is already ${pr.status}`);
  }

  return {
    canMerge,
    reasons,
    ci: {
      passed: ciPassed,
      required: policy.requireCiPassed,
      checks,
      missingChecks,
    },
    approvals: {
      passed: approvalsPassed,
      approvedHandles,
      changesRequestedHandles,
      missingRequiredApprovers,
      unsatisfiedGroups,
      minApprovals: policy.minApprovals,
    },
    comments: {
      passed: commentsPassed,
      unresolvedBlockingIds,
      unresolvedErrorFindingIds,
      deferredCount,
    },
  };
}

/**
 * Evaluates agent-aware diff filter rules for a given viewer.
 * Example: Hide test files (`**\/*.test.*`) for human reviewers whenever `test-review-agent`
 * is assigned (and/or has approved the current head commit).
 */
export function filterDiffFiles(params: {
  pr: PullRequest;
  files: DiffFile[];
  rules: DiffFilterRule[];
  viewer: Pick<Actor, "handle" | "type">;
  reviews: PrReview[];
  includeHidden?: boolean;
}): FilteredDiffResponse {
  const { pr, files, rules, viewer, reviews, includeHidden = false } = params;
  // Agent-approved diff filters only trust approvals for the current PR head SHA
  const effectiveReviews = getEffectiveReviewsByActor(reviews, pr.headSha, true);
  const assignedSet = new Set(pr.assignedAgents);

  const activeRules = rules.filter((rule) => {
    if (!rule.enabled) return false;
    const matchesActorType =
      rule.hideForActorTypes.length > 0 && rule.hideForActorTypes.includes(viewer.type);
    const matchesHandle =
      rule.hideForHandles.length > 0 && rule.hideForHandles.includes(viewer.handle);
    if (!matchesActorType && !matchesHandle) return false;

    if (rule.whenAgentAssigned && !assignedSet.has(rule.whenAgentAssigned)) {
      return false;
    }
    if (rule.whenAgentApproved) {
      const agentReview = effectiveReviews.get(rule.whenAgentApproved);
      if (!agentReview || agentReview.status !== "approved") {
        return false;
      }
    }
    return true;
  });

  const visibleFiles: DiffFile[] = [];
  const hiddenFiles: HiddenDiffFile[] = [];

  for (const file of files) {
    const matchedRule = activeRules.find((r) => matchAnyGlob(file.path, r.filePatterns));
    if (matchedRule) {
      const coveredBy = matchedRule.whenAgentApproved ?? matchedRule.whenAgentAssigned ?? null;
      const reasonParts: string[] = [];
      if (matchedRule.whenAgentApproved) {
        reasonParts.push(`approved by ${matchedRule.whenAgentApproved}`);
      } else if (matchedRule.whenAgentAssigned) {
        reasonParts.push(`assigned to ${matchedRule.whenAgentAssigned}`);
      } else {
        reasonParts.push(`matched rule '${matchedRule.name}'`);
      }

      hiddenFiles.push({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hiddenByRuleId: matchedRule.id,
        hiddenByRuleName: matchedRule.name,
        coveredByAgent: coveredBy,
        reason: `Hidden for ${viewer.type} (${reasonParts.join(", ")})`,
      });
      if (includeHidden) {
        visibleFiles.push(file);
      }
    } else {
      visibleFiles.push(file);
    }
  }

  return {
    prNumber: pr.number,
    headSha: pr.headSha,
    viewerHandle: viewer.handle,
    viewerType: viewer.type,
    includeHidden,
    visibleFiles,
    hiddenFiles,
  };
}
