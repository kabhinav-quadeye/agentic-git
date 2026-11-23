import React, { useEffect, useState } from "react";
import type {
  Actor,
  CommentTypeDefinition,
  DiffFilterRule,
  ForgeType,
  MergeMethod,
  Repo,
  WebhookEventType,
  WebhookSubscription,
} from "@agentic-git/shared";
import { BotIcon, GearIcon, PulseIcon, RepoIcon, ShieldIcon } from "./icons";

const ALL_WEBHOOK_EVENTS: WebhookEventType[] = [
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
];

interface SettingsPanelProps {
  currentRepo: Repo | null;
  agents: Actor[];
  webhooks: WebhookSubscription[];
  apiFetch: <T>(route: string, init?: RequestInit) => Promise<T>;
  onRefresh: () => Promise<void>;
  onSelectRepo: (slug: string) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  currentRepo,
  agents,
  webhooks,
  apiFetch,
  onRefresh,
  onSelectRepo,
  onError,
  onNotice,
}) => {
  // ---- Connect Repo form ----
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newForge, setNewForge] = useState<ForgeType>("github");
  const [newUpstreamRepo, setNewUpstreamRepo] = useState("");
  const [newUpstreamGitUrl, setNewUpstreamGitUrl] = useState("");
  const [newUpstreamToken, setNewUpstreamToken] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState("");
  const [newDefaultBranch, setNewDefaultBranch] = useState("main");

  // ---- Editable Merge Policy ----
  const [protectedText, setProtectedText] = useState("");
  const [requireCi, setRequireCi] = useState(true);
  const [requiredChecksText, setRequiredChecksText] = useState("");
  const [minApprovals, setMinApprovals] = useState(1);
  const [requiredApproversText, setRequiredApproversText] = useState("");
  const [anyOfGroupsText, setAnyOfGroupsText] = useState("");
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [invalidateOnPush, setInvalidateOnPush] = useState(false);
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);
  const [allowAuthorResolveBlocking, setAllowAuthorResolveBlocking] = useState(false);
  const [defaultAutoMerge, setDefaultAutoMerge] = useState(false);

  // ---- Add Diff Filter Rule ----
  const [ruleName, setRuleName] = useState("");
  const [rulePatterns, setRulePatterns] = useState("**/*.test.{ts,tsx,js}");
  const [ruleAgentApproved, setRuleAgentApproved] = useState("");
  const [ruleAgentAssigned, setRuleAgentAssigned] = useState("");

  // ---- Add Custom Comment Type ----
  const [ctKey, setCtKey] = useState("");
  const [ctLabel, setCtLabel] = useState("");
  const [ctBlocks, setCtBlocks] = useState(false);
  const [ctInstruction, setCtInstruction] = useState("");
  const [ctColor, setCtColor] = useState("#0ea5e9");

  // ---- Register Agent Bot ----
  const [botHandle, setBotHandle] = useState("");
  const [botName, setBotName] = useState("");
  const [botBranches, setBotBranches] = useState("agent/**,feature/**");
  const [botWebhookUrl, setBotWebhookUrl] = useState("");
  const [botCanApprove, setBotCanApprove] = useState(true);
  const [botCanMerge, setBotCanMerge] = useState(false);
  const [createdBotToken, setCreatedBotToken] = useState<{ handle: string; token: string } | null>(
    null,
  );

  // ---- Add Webhook ----
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("agentic-git-secret");
  const [whEvents, setWhEvents] = useState<WebhookEventType[]>([
    "pr.opened",
    "comment.created",
    "agent.invoked",
  ]);

  useEffect(() => {
    if (!currentRepo) return;
    setProtectedText(currentRepo.protectedBranches.join(", "));
    setRequireCi(currentRepo.mergePolicy.requireCiPassed);
    setRequiredChecksText(currentRepo.mergePolicy.requiredChecks.join(", "));
    setMinApprovals(currentRepo.mergePolicy.minApprovals);
    setRequiredApproversText(currentRepo.mergePolicy.requiredApprovers.join(", "));
    setAnyOfGroupsText(
      currentRepo.mergePolicy.anyOfApprovalGroups.map((g) => g.join(", ")).join("\n"),
    );
    setMergeMethod(currentRepo.mergePolicy.mergeMethod ?? "squash");
    setInvalidateOnPush(currentRepo.mergePolicy.invalidateApprovalsOnPush);
    setAllowSelfApproval(Boolean(currentRepo.mergePolicy.allowSelfApproval));
    setAllowAuthorResolveBlocking(Boolean(currentRepo.mergePolicy.allowAuthorResolveBlocking));
    setDefaultAutoMerge(currentRepo.mergePolicy.defaultAutoMerge);
  }, [currentRepo]);

  const handleCreateRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug.trim()) return;
    const slug = newSlug.trim();
    const upstreamRepo = newUpstreamRepo.trim() || slug;
    const upstreamGitUrl =
      newUpstreamGitUrl.trim() ||
      (newForge === "github"
        ? `https://github.com/${upstreamRepo}.git`
        : newForge === "gitlab"
          ? `https://gitlab.com/${upstreamRepo}.git`
          : upstreamRepo);
    const forgeBaseUrl =
      newForge === "github"
        ? "https://api.github.com"
        : newForge === "gitlab"
          ? "https://gitlab.com"
          : "local://upstream";
    try {
      await apiFetch("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          slug,
          forgeType: newForge,
          forgeBaseUrl,
          upstreamRepo,
          upstreamGitUrl,
          upstreamToken: newUpstreamToken.trim(),
          incomingWebhookSecret: newWebhookSecret.trim(),
          defaultBranch: newDefaultBranch.trim() || "main",
          protectedBranches: [newDefaultBranch.trim() || "main"],
        }),
      });
      setShowAddRepo(false);
      setNewSlug("");
      setNewUpstreamRepo("");
      setNewUpstreamGitUrl("");
      setNewUpstreamToken("");
      setNewWebhookSecret("");
      await onRefresh();
      onSelectRepo(slug);
      onNotice(`Connected repository ${slug}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRepo) return;
    const anyOfApprovalGroups = anyOfGroupsText
      .split("\n")
      .map((line) =>
        line
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .filter((g) => g.length > 0);
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          protectedBranches: protectedText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          mergePolicy: {
            requireCiPassed: requireCi,
            requiredChecks: requiredChecksText
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            minApprovals: Number(minApprovals) || 0,
            requiredApprovers: requiredApproversText
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            anyOfApprovalGroups,
            mergeMethod,
            invalidateApprovalsOnPush: invalidateOnPush,
            allowSelfApproval,
            allowAuthorResolveBlocking,
            defaultAutoMerge,
          },
        }),
      });
      await onRefresh();
      onNotice(`Saved merge policy for ${currentRepo.slug}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRepo || !ruleName.trim() || !rulePatterns.trim()) return;
    const nextRule: DiffFilterRule = {
      id: `rule_${Date.now().toString(36)}`,
      name: ruleName.trim(),
      description: "",
      filePatterns: rulePatterns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      hideForActorTypes: ["human"],
      hideForHandles: [],
      whenAgentApproved: ruleAgentApproved.trim() || null,
      whenAgentAssigned: ruleAgentAssigned.trim() || null,
      enabled: true,
    };
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          diffFilterRules: [...currentRepo.diffFilterRules, nextRule],
        }),
      });
      setRuleName("");
      setRuleAgentApproved("");
      setRuleAgentAssigned("");
      await onRefresh();
      onNotice(`Added diff filter rule '${nextRule.name}'.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleRule = async (ruleId: string) => {
    if (!currentRepo) return;
    const next = currentRepo.diffFilterRules.map((r) =>
      r.id === ruleId ? { ...r, enabled: !r.enabled } : r,
    );
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}`, {
        method: "PATCH",
        body: JSON.stringify({ diffFilterRules: next }),
      });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!currentRepo) return;
    const next = currentRepo.diffFilterRules.filter((r) => r.id !== ruleId);
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}`, {
        method: "PATCH",
        body: JSON.stringify({ diffFilterRules: next }),
      });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddCommentType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRepo || !ctKey.trim() || !ctLabel.trim()) return;
    const nextType: CommentTypeDefinition = {
      key: ctKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      label: ctLabel.trim(),
      description: "",
      blocksMerge: ctBlocks,
      agentInstruction: ctInstruction.trim(),
      color: ctColor,
      builtin: false,
    };
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          customCommentTypes: [
            ...currentRepo.customCommentTypes.filter((t) => t.key !== nextType.key),
            nextType,
          ],
        }),
      });
      setCtKey("");
      setCtLabel("");
      setCtInstruction("");
      await onRefresh();
      onNotice(`Added comment type '${nextType.label}'.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botHandle.trim() || !botName.trim()) return;
    try {
      const res = await apiFetch<{ actor: Actor; token: string }>("/api/actors", {
        method: "POST",
        body: JSON.stringify({
          handle: botHandle.trim(),
          displayName: botName.trim(),
          type: "agent",
          role: "agent",
          allowedBranchPatterns: botBranches
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          canApprove: botCanApprove,
          canMerge: botCanMerge,
          agentWebhookUrl: botWebhookUrl.trim() || null,
        }),
      });
      setCreatedBotToken({ handle: res.actor.handle, token: res.token });
      setBotHandle("");
      setBotName("");
      setBotWebhookUrl("");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeAgent = async (actor: Actor) => {
    try {
      await apiFetch(`/api/actors/${actor.id}`, { method: "DELETE" });
      await onRefresh();
      onNotice(`Revoked agent bot '${actor.handle}'.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRepo || !whUrl.trim() || whEvents.length === 0) return;
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          url: whUrl.trim(),
          secret: whSecret.trim() || "agentic-git-secret",
          events: whEvents,
        }),
      });
      setWhUrl("");
      await onRefresh();
      onNotice("Added outgoing webhook subscription.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    if (!currentRepo) return;
    try {
      await apiFetch(`/api/repos/${currentRepo.slug}/webhooks/${id}`, { method: "DELETE" });
      await onRefresh();
      onNotice("Deleted webhook subscription.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Connect Repository */}
      <section className="gh-box">
        <div className="gh-box-header">
          <span className="row">
            <RepoIcon size={15} />
            <span>Repositories</span>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddRepo((v) => !v)}
          >
            {showAddRepo ? "Cancel" : "+ Connect Repository"}
          </button>
        </div>
        {showAddRepo && (
          <form onSubmit={handleCreateRepo} style={{ padding: 16 }} className="stack">
            <div className="gh-form-grid">
              <div className="gh-field">
                <label>Repository Slug (org/repo)</label>
                <input
                  className="input mono"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="acme/payments-api"
                  required
                />
              </div>
              <div className="gh-field">
                <label>Upstream Forge</label>
                <select
                  className="select"
                  value={newForge}
                  onChange={(e) => setNewForge(e.target.value as ForgeType)}
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="local">Local bare Git</option>
                </select>
              </div>
              <div className="gh-field">
                <label>Default Branch</label>
                <input
                  className="input mono"
                  value={newDefaultBranch}
                  onChange={(e) => setNewDefaultBranch(e.target.value)}
                  placeholder="main"
                />
              </div>
              <div className="gh-field">
                <label>Upstream Repo (optional)</label>
                <input
                  className="input mono"
                  value={newUpstreamRepo}
                  onChange={(e) => setNewUpstreamRepo(e.target.value)}
                  placeholder="defaults to slug"
                />
              </div>
              <div className="gh-field">
                <label>Upstream Git URL (optional)</label>
                <input
                  className="input mono"
                  value={newUpstreamGitUrl}
                  onChange={(e) => setNewUpstreamGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
              </div>
              <div className="gh-field">
                <label>Upstream PAT</label>
                <input
                  type="password"
                  className="input mono"
                  value={newUpstreamToken}
                  onChange={(e) => setNewUpstreamToken(e.target.value)}
                  placeholder="ghp_..."
                />
              </div>
              <div className="gh-field">
                <label>Incoming Webhook Secret</label>
                <input
                  type="password"
                  className="input mono"
                  value={newWebhookSecret}
                  onChange={(e) => setNewWebhookSecret(e.target.value)}
                  placeholder="HMAC secret for GitHub/GitLab webhooks"
                />
              </div>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="submit" className="btn btn-primary">
                Register Repository
              </button>
            </div>
          </form>
        )}
      </section>

      {currentRepo && (
        <>
          {/* Editable Merge Gate Policy */}
          <section className="gh-box">
            <div className="gh-box-header">
              <span className="row">
                <ShieldIcon size={15} />
                <span>Merge Gate Policy — {currentRepo.slug}</span>
              </span>
              <span className="gh-label gh-label-neutral">
                {currentRepo.forgeType} · {currentRepo.credentialMode}
              </span>
            </div>
            <form onSubmit={handleSavePolicy} style={{ padding: 16 }} className="stack">
              <div className="gh-form-grid">
                <div className="gh-field">
                  <label>Protected Branches (comma-separated globs)</label>
                  <input
                    className="input mono"
                    value={protectedText}
                    onChange={(e) => setProtectedText(e.target.value)}
                  />
                </div>
                <div className="gh-field">
                  <label>Required CI Checks (comma-separated)</label>
                  <input
                    className="input mono"
                    value={requiredChecksText}
                    onChange={(e) => setRequiredChecksText(e.target.value)}
                    placeholder="ci/test, lint"
                  />
                </div>
                <div className="gh-field">
                  <label>Min Approvals</label>
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={minApprovals}
                    onChange={(e) => setMinApprovals(Number(e.target.value))}
                  />
                </div>
                <div className="gh-field">
                  <label>Merge Method</label>
                  <select
                    className="select"
                    value={mergeMethod}
                    onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
                  >
                    <option value="squash">Squash and merge</option>
                    <option value="merge">Create a merge commit</option>
                    <option value="rebase">Rebase and merge</option>
                  </select>
                </div>
                <div className="gh-field">
                  <label>Required Approvers (all must approve)</label>
                  <input
                    className="input mono"
                    value={requiredApproversText}
                    onChange={(e) => setRequiredApproversText(e.target.value)}
                    placeholder="alice, security-agent"
                  />
                </div>
                <div className="gh-field">
                  <label>Any-Of Approval Groups (one group per line)</label>
                  <textarea
                    rows={2}
                    className="textarea mono"
                    value={anyOfGroupsText}
                    onChange={(e) => setAnyOfGroupsText(e.target.value)}
                    placeholder={"alice, bob\nsecurity-agent, lead-eng"}
                  />
                </div>
              </div>

              <div className="row" style={{ gap: 18 }}>
                <label className="gh-check-row">
                  <input
                    type="checkbox"
                    checked={requireCi}
                    onChange={(e) => setRequireCi(e.target.checked)}
                  />
                  <span>Require CI passed</span>
                </label>
                <label className="gh-check-row">
                  <input
                    type="checkbox"
                    checked={invalidateOnPush}
                    onChange={(e) => setInvalidateOnPush(e.target.checked)}
                  />
                  <span>Invalidate approvals on new push</span>
                </label>
                <label className="gh-check-row">
                  <input
                    type="checkbox"
                    checked={defaultAutoMerge}
                    onChange={(e) => setDefaultAutoMerge(e.target.checked)}
                  />
                  <span>Default auto-merge on new PRs</span>
                </label>
                <label className="gh-check-row">
                  <input
                    type="checkbox"
                    checked={allowSelfApproval}
                    onChange={(e) => setAllowSelfApproval(e.target.checked)}
                  />
                  <span>Allow PR self-approval</span>
                </label>
                <label className="gh-check-row">
                  <input
                    type="checkbox"
                    checked={allowAuthorResolveBlocking}
                    onChange={(e) => setAllowAuthorResolveBlocking(e.target.checked)}
                  />
                  <span>Allow PR author to resolve blocking comments</span>
                </label>
              </div>

              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="submit" className="btn btn-primary">
                  Save Merge Policy
                </button>
              </div>
            </form>
          </section>

          {/* Editable Diff Filter Rules */}
          <section className="gh-box">
            <div className="gh-box-header">
              <span className="row">
                <GearIcon size={15} />
                <span>Agent-Aware Diff Filter Rules</span>
              </span>
              <span className="muted tabular">{currentRepo.diffFilterRules.length} rules</span>
            </div>
            {currentRepo.diffFilterRules.length > 0 && (
              <table className="gh-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>File Patterns</th>
                    <th>Condition</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {currentRepo.diffFilterRules.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.name}</strong></td>
                      <td className="mono">{r.filePatterns.join(", ")}</td>
                      <td className="muted">
                        {r.whenAgentApproved
                          ? `Approved by ${r.whenAgentApproved}`
                          : r.whenAgentAssigned
                            ? `Assigned to ${r.whenAgentAssigned}`
                            : "Always for humans"}
                      </td>
                      <td>
                        <span className={`gh-label ${r.enabled ? "gh-label-pass" : "gh-label-neutral"}`}>
                          {r.enabled ? "Active" : "Paused"}
                        </span>
                      </td>
                      <td>
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => handleToggleRule(r.id)}
                          >
                            {r.enabled ? "Pause" : "Enable"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => handleDeleteRule(r.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <form
              onSubmit={handleAddRule}
              style={{ padding: 14, borderTop: "1px solid var(--gh-border-muted)" }}
              className="row"
            >
              <input
                className="input"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="Rule name (e.g. Hide reviewed tests)"
                style={{ flex: 1, minWidth: 160 }}
              />
              <input
                className="input mono"
                value={rulePatterns}
                onChange={(e) => setRulePatterns(e.target.value)}
                placeholder="Glob patterns (**/*.test.ts)"
                style={{ flex: 1, minWidth: 180 }}
              />
              <input
                className="input mono"
                value={ruleAgentApproved}
                onChange={(e) => setRuleAgentApproved(e.target.value)}
                placeholder="When agent approved (optional)"
                style={{ width: 190 }}
              />
              <input
                className="input mono"
                value={ruleAgentAssigned}
                onChange={(e) => setRuleAgentAssigned(e.target.value)}
                placeholder="When agent assigned (optional)"
                style={{ width: 190 }}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                + Add Rule
              </button>
            </form>
          </section>

          {/* Custom Comment Types */}
          <section className="gh-box">
            <div className="gh-box-header">
              <span>Custom Review Comment Types</span>
              <span className="muted tabular">{currentRepo.customCommentTypes.length} custom</span>
            </div>
            <form onSubmit={handleAddCommentType} style={{ padding: 14 }} className="row">
              <input
                className="input mono"
                value={ctKey}
                onChange={(e) => setCtKey(e.target.value)}
                placeholder="key (e.g. security_blocker)"
                style={{ width: 160 }}
              />
              <input
                className="input"
                value={ctLabel}
                onChange={(e) => setCtLabel(e.target.value)}
                placeholder="Display label"
                style={{ width: 150 }}
              />
              <input
                className="input"
                value={ctInstruction}
                onChange={(e) => setCtInstruction(e.target.value)}
                placeholder="Agent directive instruction"
                style={{ flex: 1, minWidth: 200 }}
              />
              <input
                type="color"
                value={ctColor}
                onChange={(e) => setCtColor(e.target.value)}
                aria-label="Comment type badge color"
                style={{ width: 32, height: 32, padding: 0, border: "none", background: "transparent" }}
              />
              <label className="gh-check-row">
                <input
                  type="checkbox"
                  checked={ctBlocks}
                  onChange={(e) => setCtBlocks(e.target.checked)}
                />
                <span>Blocks merge</span>
              </label>
              <button type="submit" className="btn btn-sm btn-primary">
                + Add Type
              </button>
            </form>
          </section>

          {/* Outgoing Webhooks */}
          <section className="gh-box">
            <div className="gh-box-header">
              <span className="row">
                <PulseIcon size={15} />
                <span>Outgoing Webhook Subscriptions</span>
              </span>
              <span className="muted tabular">{webhooks.length} active</span>
            </div>
            {webhooks.length > 0 && (
              <table className="gh-table">
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Events</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((w) => (
                    <tr key={w.id}>
                      <td className="mono">{w.url}</td>
                      <td className="mono muted">{w.events.join(", ")}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDeleteWebhook(w.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <form
              onSubmit={handleAddWebhook}
              style={{ padding: 14, borderTop: "1px solid var(--gh-border-muted)" }}
              className="stack"
            >
              <div className="row">
                <input
                  className="input mono"
                  value={whUrl}
                  onChange={(e) => setWhUrl(e.target.value)}
                  placeholder="https://my-agent-runner.internal/webhooks/agit"
                  style={{ flex: 2, minWidth: 240 }}
                />
                <input
                  className="input mono"
                  value={whSecret}
                  onChange={(e) => setWhSecret(e.target.value)}
                  placeholder="HMAC secret"
                  style={{ flex: 1, minWidth: 150 }}
                />
                <button type="submit" className="btn btn-primary btn-sm">
                  + Add Webhook
                </button>
              </div>
              <div className="row" style={{ gap: 10 }}>
                {ALL_WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="gh-check-row" style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={whEvents.includes(ev)}
                      onChange={(e) =>
                        setWhEvents((prev) =>
                          e.target.checked ? [...prev, ev] : prev.filter((x) => x !== ev),
                        )
                      }
                    />
                    <span className="mono">{ev}</span>
                  </label>
                ))}
              </div>
            </form>
          </section>
        </>
      )}

      {/* Agent Bots Management */}
      <section className="gh-box">
        <div className="gh-box-header">
          <span className="row">
            <BotIcon size={15} />
            <span>Registered Agent Bots</span>
          </span>
          <span className="muted tabular">{agents.length} bots</span>
        </div>

        {createdBotToken && (
          <div
            className="gh-hidden-notice"
            style={{
              margin: 14,
              background: "var(--gh-success-subtle)",
              borderColor: "var(--gh-success-emphasis)",
            }}
          >
            <div>
              <strong>Bot token for {createdBotToken.handle} (shown once):</strong>{" "}
              <code className="mono">{createdBotToken.token}</code>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(createdBotToken.token);
                onNotice(`Copied token for ${createdBotToken.handle}.`);
              }}
            >
              Copy token
            </button>
          </div>
        )}

        <table className="gh-table">
          <thead>
            <tr>
              <th>Handle</th>
              <th>Display Name</th>
              <th>Allowed Branches</th>
              <th>Approve</th>
              <th>Merge</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.handle}</td>
                <td>{a.displayName}</td>
                <td className="mono muted">{a.allowedBranchPatterns.join(", ")}</td>
                <td>{a.canApprove ? "Yes" : "No"}</td>
                <td>{a.canMerge ? "Yes" : "No"}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => handleRevokeAgent(a)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form
          onSubmit={handleCreateAgent}
          style={{ padding: 14, borderTop: "1px solid var(--gh-border-muted)" }}
          className="stack"
        >
          <div className="gh-form-grid">
            <input
              className="input mono"
              value={botHandle}
              onChange={(e) => setBotHandle(e.target.value)}
              placeholder="Agent handle (e.g. claude-coder)"
            />
            <input
              className="input"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="Display name"
            />
            <input
              className="input mono"
              value={botBranches}
              onChange={(e) => setBotBranches(e.target.value)}
              placeholder="Allowed branches (agent/**,feature/**)"
            />
            <input
              className="input mono"
              value={botWebhookUrl}
              onChange={(e) => setBotWebhookUrl(e.target.value)}
              placeholder="Direct webhook URL (optional)"
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row" style={{ gap: 16 }}>
              <label className="gh-check-row">
                <input
                  type="checkbox"
                  checked={botCanApprove}
                  onChange={(e) => setBotCanApprove(e.target.checked)}
                />
                <span>Can approve PRs</span>
              </label>
              <label className="gh-check-row">
                <input
                  type="checkbox"
                  checked={botCanMerge}
                  onChange={(e) => setBotCanMerge(e.target.checked)}
                />
                <span>Can merge PRs</span>
              </label>
            </div>
            <button type="submit" className="btn btn-primary btn-sm">
              + Register Agent Bot
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};
