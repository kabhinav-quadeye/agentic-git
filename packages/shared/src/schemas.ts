import { z } from "zod";

export const ActorTypeSchema = z.enum(["human", "agent"]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActorRoleSchema = z.enum(["admin", "maintainer", "developer", "agent"]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

export const ForgeTypeSchema = z.enum(["github", "gitlab", "local"]);
export type ForgeType = z.infer<typeof ForgeTypeSchema>;

export const CredentialModeSchema = z.enum(["service", "per_user"]);
export type CredentialMode = z.infer<typeof CredentialModeSchema>;

export const ActorSchema = z.object({
  id: z.string(),
  handle: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1),
  type: ActorTypeSchema,
  role: ActorRoleSchema,
  ownerId: z.string().nullable(),
  allowedBranchPatterns: z.array(z.string()).default(["**"]),
  canMerge: z.boolean().default(false),
  canApprove: z.boolean().default(true),
  agentWebhookUrl: z.string().url().nullable().optional(),
  createdAt: z.string(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const CreateActorInputSchema = z.object({
  handle: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1),
  type: ActorTypeSchema.default("human"),
  role: ActorRoleSchema.default("developer"),
  ownerId: z.string().nullable().optional(),
  allowedBranchPatterns: z.array(z.string()).optional(),
  canMerge: z.boolean().optional(),
  canApprove: z.boolean().optional(),
  agentWebhookUrl: z.string().url().nullable().optional(),
  upstreamToken: z.string().optional(),
});
export type CreateActorInput = z.infer<typeof CreateActorInputSchema>;

export const CommentTypeDefinitionSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  description: z.string().default(""),
  blocksMerge: z.boolean().default(false),
  agentInstruction: z.string().default(""),
  color: z.string().default("#64748b"),
  builtin: z.boolean().default(false),
});
export type CommentTypeDefinition = z.infer<typeof CommentTypeDefinitionSchema>;

export const BUILTIN_COMMENT_TYPES: CommentTypeDefinition[] = [
  {
    key: "blocking",
    label: "Blocking",
    description: "Must be resolved before this PR can be merged.",
    blocksMerge: true,
    agentInstruction:
      "REQUIRED BEFORE MERGE: Address this feedback in the current PR, push your fix, and mark the comment resolved.",
    color: "#dc2626",
    builtin: true,
  },
  {
    key: "defer_to_next_pr",
    label: "Defer to Next PR",
    description: "Intentionally deferred to a follow-up PR. Does not block merge.",
    blocksMerge: false,
    agentInstruction:
      "DO NOT FIX IN THIS PR: Acknowledge this item and record it for a follow-up PR. Do not modify code for this comment now.",
    color: "#7c3aed",
    builtin: true,
  },
  {
    key: "suggestion",
    label: "Suggestion",
    description: "Optional improvement. Does not block merge.",
    blocksMerge: false,
    agentInstruction:
      "OPTIONAL IMPROVEMENT: Apply if clearly beneficial and low risk; safe to leave unchanged if out of scope.",
    color: "#0284c7",
    builtin: true,
  },
  {
    key: "question",
    label: "Question",
    description: "Clarification or discussion thread. Does not block merge.",
    blocksMerge: false,
    agentInstruction:
      "CLARIFICATION: Reply with an explanation or context. Do not change code unless the thread turns into a blocking request.",
    color: "#d97706",
    builtin: true,
  },
  {
    key: "agent_finding",
    label: "Agent Finding",
    description: "Structured automated review finding produced by an agent.",
    blocksMerge: false,
    agentInstruction:
      "AUTOMATED FINDING: Severity 'error' blocks merge when blockOnErrorFindings is enabled; 'warning' and 'info' are advisory.",
    color: "#059669",
    builtin: true,
  },
];

export const MergePolicySchema = z.object({
  requireCiPassed: z.boolean().default(true),
  requiredChecks: z.array(z.string()).default([]),
  minApprovals: z.number().int().min(0).default(1),
  requiredApprovers: z.array(z.string()).default([]),
  anyOfApprovalGroups: z.array(z.array(z.string())).default([]),
  blockOnErrorFindings: z.boolean().default(true),
  invalidateApprovalsOnPush: z.boolean().default(false),
  defaultAutoMerge: z.boolean().default(false),
});
export type MergePolicy = z.infer<typeof MergePolicySchema>;

export const DEFAULT_MERGE_POLICY: MergePolicy = MergePolicySchema.parse({});

export const DiffFilterRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  filePatterns: z.array(z.string().min(1)).min(1),
  hideForActorTypes: z.array(ActorTypeSchema).default(["human"]),
  hideForHandles: z.array(z.string()).default([]),
  whenAgentAssigned: z.string().nullable().optional(),
  whenAgentApproved: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});
export type DiffFilterRule = z.infer<typeof DiffFilterRuleSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/),
  forgeType: ForgeTypeSchema,
  forgeBaseUrl: z.string(),
  upstreamRepo: z.string(),
  upstreamGitUrl: z.string(),
  defaultBranch: z.string().default("main"),
  credentialMode: CredentialModeSchema.default("service"),
  protectedBranches: z.array(z.string()).default(["main", "master"]),
  mergePolicy: MergePolicySchema,
  diffFilterRules: z.array(DiffFilterRuleSchema).default([]),
  customCommentTypes: z.array(CommentTypeDefinitionSchema).default([]),
  createdAt: z.string(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const CreateRepoInputSchema = z.object({
  slug: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/),
  forgeType: ForgeTypeSchema,
  forgeBaseUrl: z.string().default(""),
  upstreamRepo: z.string().min(1),
  upstreamGitUrl: z.string().min(1),
  upstreamToken: z.string().default(""),
  defaultBranch: z.string().default("main"),
  credentialMode: CredentialModeSchema.default("service"),
  protectedBranches: z.array(z.string()).default(["main", "master"]),
  mergePolicy: MergePolicySchema.partial().optional(),
  diffFilterRules: z.array(DiffFilterRuleSchema).optional(),
  customCommentTypes: z.array(CommentTypeDefinitionSchema).optional(),
});
export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;

export const CiCheckStatusSchema = z.enum(["pending", "running", "passed", "failed", "cancelled"]);
export type CiCheckStatus = z.infer<typeof CiCheckStatusSchema>;

export const CiCheckSchema = z.object({
  name: z.string(),
  status: CiCheckStatusSchema,
  url: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  updatedAt: z.string(),
});
export type CiCheck = z.infer<typeof CiCheckSchema>;

export const PrStatusSchema = z.enum(["open", "merged", "closed"]);
export type PrStatus = z.infer<typeof PrStatusSchema>;

export const PullRequestSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  repoId: z.string(),
  repoSlug: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  headSha: z.string(),
  status: PrStatusSchema,
  authorActorId: z.string(),
  authorHandle: z.string(),
  authorType: ActorTypeSchema,
  authorOwnerHandle: z.string().nullable().optional(),
  upstreamPrId: z.string().nullable(),
  upstreamPrUrl: z.string().nullable(),
  autoMerge: z.boolean().default(false),
  assignedAgents: z.array(z.string()).default([]),
  ciChecks: z.array(CiCheckSchema).default([]),
  mergedAt: z.string().nullable().optional(),
  mergedByActorId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const CreatePrInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().optional(),
  headSha: z.string().optional(),
  autoMerge: z.boolean().optional(),
  assignedAgents: z.array(z.string()).optional(),
});
export type CreatePrInput = z.infer<typeof CreatePrInputSchema>;

export const FindingSeveritySchema = z.enum(["info", "warning", "error"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const PrCommentSchema = z.object({
  id: z.string(),
  prId: z.string(),
  parentId: z.string().nullable().optional(),
  authorActorId: z.string(),
  authorHandle: z.string(),
  authorType: ActorTypeSchema,
  authorOwnerHandle: z.string().nullable().optional(),
  commentType: z.string(),
  commentTypeMeta: CommentTypeDefinitionSchema.optional(),
  body: z.string().min(1),
  filePath: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  severity: FindingSeveritySchema.nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  resolved: z.boolean().default(false),
  resolvedByHandle: z.string().nullable().optional(),
  resolvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type PrComment = z.infer<typeof PrCommentSchema>;

export const CreateCommentInputSchema = z.object({
  commentType: z.string().default("suggestion"),
  body: z.string().min(1),
  parentId: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  severity: FindingSeveritySchema.nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>;

export const ReviewStatusSchema = z.enum(["approved", "changes_requested", "commented"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const PrReviewSchema = z.object({
  id: z.string(),
  prId: z.string(),
  actorId: z.string(),
  actorHandle: z.string(),
  actorType: ActorTypeSchema,
  actorOwnerHandle: z.string().nullable().optional(),
  status: ReviewStatusSchema,
  body: z.string().default(""),
  commitSha: z.string(),
  createdAt: z.string(),
});
export type PrReview = z.infer<typeof PrReviewSchema>;

export const CreateReviewInputSchema = z.object({
  status: ReviewStatusSchema,
  body: z.string().default(""),
});
export type CreateReviewInput = z.infer<typeof CreateReviewInputSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  patch: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const HiddenDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  hiddenByRuleId: z.string(),
  hiddenByRuleName: z.string(),
  coveredByAgent: z.string().nullable().optional(),
  reason: z.string(),
});
export type HiddenDiffFile = z.infer<typeof HiddenDiffFileSchema>;

export const FilteredDiffResponseSchema = z.object({
  prNumber: z.number().int(),
  headSha: z.string(),
  viewerHandle: z.string(),
  viewerType: ActorTypeSchema,
  includeHidden: z.boolean(),
  visibleFiles: z.array(DiffFileSchema),
  hiddenFiles: z.array(HiddenDiffFileSchema),
});
export type FilteredDiffResponse = z.infer<typeof FilteredDiffResponseSchema>;

export const MergeGateResultSchema = z.object({
  canMerge: z.boolean(),
  reasons: z.array(z.string()),
  ci: z.object({
    passed: z.boolean(),
    required: z.boolean(),
    checks: z.array(CiCheckSchema),
    missingChecks: z.array(z.string()),
  }),
  approvals: z.object({
    passed: z.boolean(),
    approvedHandles: z.array(z.string()),
    changesRequestedHandles: z.array(z.string()),
    missingRequiredApprovers: z.array(z.string()),
    unsatisfiedGroups: z.array(z.array(z.string())),
    minApprovals: z.number().int(),
  }),
  comments: z.object({
    passed: z.boolean(),
    unresolvedBlockingIds: z.array(z.string()),
    unresolvedErrorFindingIds: z.array(z.string()),
    deferredCount: z.number().int(),
  }),
});
export type MergeGateResult = z.infer<typeof MergeGateResultSchema>;

export const WebhookEventTypeSchema = z.enum([
  "pr.opened",
  "pr.updated",
  "pr.merged",
  "pr.closed",
  "comment.created",
  "comment.resolved",
  "comment.reopened",
  "review.submitted",
  "ci.updated",
  "agent.invoked",
]);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export const WebhookSubscriptionSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  url: z.string().url(),
  secret: z.string(),
  events: z.array(WebhookEventTypeSchema),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
});
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

export const CreateWebhookInputSchema = z.object({
  url: z.string().url(),
  secret: z.string().default("agentic-git-secret"),
  events: z.array(WebhookEventTypeSchema).min(1),
  enabled: z.boolean().default(true),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookInputSchema>;

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  event: WebhookEventTypeSchema,
  url: z.string(),
  payload: z.record(z.unknown()),
  statusCode: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const PushAuditEntrySchema = z.object({
  id: z.string(),
  repoId: z.string(),
  actorId: z.string(),
  actorHandle: z.string(),
  actorType: ActorTypeSchema,
  ownerHandle: z.string().nullable(),
  ref: z.string(),
  oldSha: z.string(),
  newSha: z.string(),
  allowed: z.boolean(),
  reason: z.string(),
  createdAt: z.string(),
});
export type PushAuditEntry = z.infer<typeof PushAuditEntrySchema>;

export const InvokeAgentInputSchema = z.object({
  agentHandle: z.string().min(1),
  prompt: z.string().default(""),
  commentId: z.string().nullable().optional(),
  targetUrl: z.string().url().optional(),
});
export type InvokeAgentInput = z.infer<typeof InvokeAgentInputSchema>;
