import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Actor,
  CommentTypeDefinition,
  FilteredDiffResponse,
  MergeGateResult,
  PrComment,
  PrReview,
  PullRequest,
  PushAuditEntry,
  Repo,
  WebhookDelivery,
} from "@agentic-git/shared";
import { parseUnifiedPatch } from "./diff-utils";
import {
  BotIcon,
  CheckCircleIcon,
  ClockIcon,
  CommentIcon,
  EyeIcon,
  EyeOffIcon,
  FileDiffIcon,
  GearIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  KeyIcon,
  MoonIcon,
  PlayIcon,
  PulseIcon,
  RepoIcon,
  ShieldIcon,
  SunIcon,
  XCircleIcon,
} from "./icons";

interface PrDetailPayload {
  pr: PullRequest;
  comments: PrComment[];
  reviews: PrReview[];
  commentTypes: CommentTypeDefinition[];
  gate: MergeGateResult;
}

type RepoTab = "pulls" | "activity" | "settings";
type PrTab = "conversation" | "checks" | "files";

function initials(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("agit_theme");
    return saved === "light" ? "light" : "dark";
  });
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("agit_server") || window.location.origin,
  );
  const [token, setToken] = useState(() => localStorage.getItem("agit_token") || "");
  const [authMenuOpen, setAuthMenuOpen] = useState(false);

  const [me, setMe] = useState<{ actor: Actor; owner: Actor | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [repoTab, setRepoTab] = useState<RepoTab>("pulls");
  const [prs, setPrs] = useState<Array<PullRequest & { gate: MergeGateResult }>>([]);
  const [selectedPrNum, setSelectedPrNum] = useState<number | null>(null);
  const [prTab, setPrTab] = useState<PrTab>("conversation");
  const [prDetail, setPrDetail] = useState<PrDetailPayload | null>(null);
  const [diffData, setDiffData] = useState<FilteredDiffResponse | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [agents, setAgents] = useState<Actor[]>([]);
  const [pushes, setPushes] = useState<PushAuditEntry[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);

  // Composer & agent invoke form state
  const [commentType, setCommentType] = useState("blocking");
  const [commentBody, setCommentBody] = useState("");
  const [commentFile, setCommentFile] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [invokeAgentHandle, setInvokeAgentHandle] = useState("");
  const [invokePrompt, setInvokePrompt] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("agit_theme", theme);
  }, [theme]);

  const apiFetch = useCallback(
    async <T,>(route: string, init?: RequestInit): Promise<T> => {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}${route}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Request failed (${res.status})`);
      }
      return json as T;
    },
    [serverUrl, token],
  );

  const loadWorkspace = useCallback(async () => {
    if (!token) {
      setMe(null);
      return;
    }
    setError(null);
    try {
      const [meRes, reposRes, agentsRes] = await Promise.all([
        apiFetch<{ actor: Actor; owner: Actor | null }>("/api/me"),
        apiFetch<{ repos: Repo[] }>("/api/repos"),
        apiFetch<{ actors: Actor[] }>("/api/actors?type=agent"),
      ]);
      setMe(meRes);
      setRepos(reposRes.repos);
      setAgents(agentsRes.actors);
      if (agentsRes.actors.length > 0 && !invokeAgentHandle) {
        setInvokeAgentHandle(agentsRes.actors[0].handle);
      }
      if (reposRes.repos.length > 0 && !selectedSlug) {
        setSelectedSlug(reposRes.repos[0].slug);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMe(null);
    }
  }, [apiFetch, token, selectedSlug, invokeAgentHandle]);

  const loadRepoData = useCallback(async () => {
    if (!token || !selectedSlug) return;
    try {
      const [prsRes, pushesRes, delivRes] = await Promise.all([
        apiFetch<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
          `/api/repos/${selectedSlug}/prs`,
        ),
        apiFetch<{ pushes: PushAuditEntry[] }>(`/api/repos/${selectedSlug}/pushes`),
        apiFetch<{ deliveries: WebhookDelivery[] }>(`/api/webhooks/deliveries`),
      ]);
      setPrs(prsRes.prs);
      setPushes(pushesRes.pushes);
      setDeliveries(delivRes.deliveries);
      if (prsRes.prs.length > 0 && selectedPrNum === null) {
        setSelectedPrNum(prsRes.prs[0].number);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiFetch, token, selectedSlug, selectedPrNum]);

  const loadPrDetail = useCallback(async () => {
    if (!token || !selectedSlug || selectedPrNum === null) return;
    try {
      const [detail, diff] = await Promise.all([
        apiFetch<PrDetailPayload>(`/api/repos/${selectedSlug}/prs/${selectedPrNum}`),
        apiFetch<FilteredDiffResponse>(
          `/api/repos/${selectedSlug}/prs/${selectedPrNum}/diff?includeHidden=${includeHidden}`,
        ),
      ]);
      setPrDetail(detail);
      setDiffData(diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiFetch, token, selectedSlug, selectedPrNum, includeHidden]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void loadRepoData();
  }, [loadRepoData]);

  useEffect(() => {
    void loadPrDetail();
  }, [loadPrDetail]);

  const currentRepo = useMemo(
    () => repos.find((r) => r.slug === selectedSlug) ?? null,
    [repos, selectedSlug],
  );

  const selectedCommentTypeDef = useMemo(
    () => prDetail?.commentTypes.find((ct) => ct.key === commentType) ?? null,
    [prDetail, commentType],
  );

  const totalChangedFiles = useMemo(() => {
    if (!diffData) return 0;
    return diffData.includeHidden
      ? diffData.visibleFiles.length
      : diffData.visibleFiles.length + diffData.hiddenFiles.length;
  }, [diffData]);

  const totalDiffStats = useMemo(() => {
    if (!diffData) return { additions: 0, deletions: 0 };
    const visAdd = diffData.visibleFiles.reduce((s, f) => s + f.additions, 0);
    const visDel = diffData.visibleFiles.reduce((s, f) => s + f.deletions, 0);
    if (diffData.includeHidden) return { additions: visAdd, deletions: visDel };
    const hidAdd = diffData.hiddenFiles.reduce((s, f) => s + f.additions, 0);
    const hidDel = diffData.hiddenFiles.reduce((s, f) => s + f.deletions, 0);
    return { additions: visAdd + hidAdd, deletions: visDel + hidDel };
  }, [diffData]);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("agit_server", serverUrl);
    localStorage.setItem("agit_token", token);
    setAuthMenuOpen(false);
    void loadWorkspace();
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug || selectedPrNum === null || !commentBody.trim()) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/comments`, {
        method: "POST",
        body: JSON.stringify({
          commentType,
          body: commentBody.trim(),
          filePath: commentFile.trim() || null,
          line: commentLine ? Number.parseInt(commentLine, 10) : null,
        }),
      });
      setCommentBody("");
      setCommentFile("");
      setCommentLine("");
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResolveComment = async (id: string, resolved: boolean) => {
    setError(null);
    try {
      await apiFetch(`/api/comments/${id}/${resolved ? "reopen" : "resolve"}`, {
        method: "POST",
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReview = async (status: "approved" | "changes_requested") => {
    if (!selectedSlug || selectedPrNum === null) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          status,
          body: status === "approved" ? "Approved via web UI." : "Requested changes via web UI.",
        }),
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleAutoMerge = async () => {
    if (!selectedSlug || selectedPrNum === null || !prDetail) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}`, {
        method: "PATCH",
        body: JSON.stringify({ autoMerge: !prDetail.pr.autoMerge }),
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMerge = async () => {
    if (!selectedSlug || selectedPrNum === null) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/merge`, {
        method: "POST",
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInvokeAgent = async (agentHandle?: string, commentId?: string) => {
    const target = agentHandle || invokeAgentHandle;
    if (!selectedSlug || selectedPrNum === null || !target) return;
    setError(null);
    try {
      const res = await apiFetch<{ deliveries: unknown[] }>(
        `/api/repos/${selectedSlug}/prs/${selectedPrNum}/invoke-agent`,
        {
          method: "POST",
          body: JSON.stringify({
            agentHandle: target,
            commentId: commentId ?? null,
            prompt: invokePrompt || `Review and respond to PR #${selectedPrNum}.`,
          }),
        },
      );
      setInvokePrompt("");
      setStatusNotice(
        `Dispatched agent.invoked webhook to ${target} (${res.deliveries.length} delivery).`,
      );
      setTimeout(() => setStatusNotice(null), 4000);
      await loadRepoData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const [orgName, repoName] = selectedSlug ? selectedSlug.split("/") : ["agentic-git", ""];

  // Combine reviews + comments chronologically for the GitHub Conversation timeline
  const timelineItems = useMemo(() => {
    if (!prDetail) return [];
    const items: Array<
      | { kind: "comment"; createdAt: string; data: PrComment }
      | { kind: "review"; createdAt: string; data: PrReview }
    > = [
      ...prDetail.comments.map((c) => ({ kind: "comment" as const, createdAt: c.createdAt, data: c })),
      ...prDetail.reviews.map((r) => ({ kind: "review" as const, createdAt: r.createdAt, data: r })),
    ];
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return items;
  }, [prDetail]);

  return (
    <div>
      {/* Global GitHub-style Header */}
      <header className="gh-header">
        <div className="gh-header-top">
          <div className="gh-brand-nav">
            <span className="gh-logo-mark" title="agentic-git">
              <GitPullRequestIcon size={16} />
            </span>
            <div className="gh-breadcrumb">
              <RepoIcon size={16} className="muted" />
              {repos.length > 0 ? (
                <>
                  <span className="muted">{orgName}</span>
                  <span className="gh-breadcrumb-sep">/</span>
                  <select
                    aria-label="Select repository"
                    className="gh-repo-select"
                    value={selectedSlug}
                    onChange={(e) => {
                      setSelectedSlug(e.target.value);
                      setSelectedPrNum(null);
                      setRepoTab("pulls");
                    }}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.slug}>
                        {r.slug.split("/")[1] ?? r.slug}
                      </option>
                    ))}
                  </select>
                  {currentRepo && (
                    <span className="gh-label gh-label-neutral">{currentRepo.forgeType}</span>
                  )}
                </>
              ) : (
                <strong>agentic-git</strong>
              )}
            </div>
          </div>

          <div className="gh-header-actions">
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </button>

            <button
              type="button"
              className="btn"
              onClick={() => setAuthMenuOpen((v) => !v)}
            >
              {me ? (
                <>
                  <span className={`gh-avatar gh-avatar-sm ${me.actor.type}`}>
                    {initials(me.actor.handle)}
                  </span>
                  <span>{me.actor.handle}</span>
                  <span className="gh-label gh-label-neutral">{me.actor.type}</span>
                </>
              ) : (
                <>
                  <KeyIcon size={14} />
                  <span>Connect token</span>
                </>
              )}
            </button>

            {authMenuOpen && (
              <form className="gh-popover" onSubmit={handleConnect}>
                <div className="gh-popover-title">Switch actor or server</div>
                <div className="gh-field">
                  <label htmlFor="agit-server">Server URL</label>
                  <input
                    id="agit-server"
                    className="input"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="http://127.0.0.1:4321"
                  />
                </div>
                <div className="gh-field">
                  <label htmlFor="agit-token">Human or Agent Bot Token</label>
                  <input
                    id="agit-token"
                    type="password"
                    className="input mono"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="agit_usr_... or agit_bot_..."
                  />
                </div>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setAuthMenuOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary btn-sm">
                    Connect
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* Repository Underline Navigation */}
        {me && (
          <nav className="gh-repo-nav" aria-label="Repository navigation">
            <button
              type="button"
              className={`gh-nav-tab ${repoTab === "pulls" ? "active" : ""}`}
              onClick={() => setRepoTab("pulls")}
            >
              <GitPullRequestIcon size={15} />
              <span>Pull requests</span>
              <span className="gh-counter">{prs.length}</span>
            </button>
            <button
              type="button"
              className={`gh-nav-tab ${repoTab === "activity" ? "active" : ""}`}
              onClick={() => setRepoTab("activity")}
            >
              <PulseIcon size={15} />
              <span>Push audit & Webhooks</span>
              <span className="gh-counter">{pushes.length}</span>
            </button>
            <button
              type="button"
              className={`gh-nav-tab ${repoTab === "settings" ? "active" : ""}`}
              onClick={() => setRepoTab("settings")}
            >
              <GearIcon size={15} />
              <span>Policy & Agents</span>
              <span className="gh-counter">{agents.length}</span>
            </button>
          </nav>
        )}
      </header>

      <main className={`gh-container ${repoTab === "pulls" && prTab === "files" ? "wide" : ""}`}>
        {error && (
          <div className="gh-error-banner" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {statusNotice && (
          <div
            className="gh-hidden-notice"
            style={{ background: "var(--gh-success-subtle)", borderColor: "var(--gh-success-emphasis)" }}
          >
            <span>{statusNotice}</span>
          </div>
        )}

        {!me ? (
          <div className="empty-state" style={{ maxWidth: 460, margin: "48px auto" }}>
            <div style={{ marginBottom: 12 }}>
              <GitPullRequestIcon size={28} />
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Sign in to agentic-git</h2>
            <p className="muted" style={{ margin: "0 0 20px" }}>
              Enter your human or agent bot token to view pull requests, agent-filtered diffs,
              typed review threads, and custom merge gates.
            </p>
            <form onSubmit={handleConnect} className="stack" style={{ textAlign: "left" }}>
              <div className="gh-field">
                <label htmlFor="login-server">Server URL</label>
                <input
                  id="login-server"
                  className="input"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                />
              </div>
              <div className="gh-field">
                <label htmlFor="login-token">Access Token</label>
                <input
                  id="login-token"
                  type="password"
                  className="input mono"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="agit_usr_... or agit_bot_..."
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                Connect to Control Plane
              </button>
            </form>
          </div>
        ) : repoTab === "activity" ? (
          <div className="stack" style={{ gap: 20 }}>
            <section className="gh-box">
              <div className="gh-box-header">
                <span className="row">
                  <GitBranchIcon size={15} />
                  <span>Git Push Attribution Log</span>
                </span>
                <span className="muted tabular">{pushes.length} events</span>
              </div>
              {pushes.length === 0 ? (
                <div style={{ padding: 24 }} className="muted">
                  No pushes recorded through the Git Smart-HTTP proxy yet.
                </div>
              ) : (
                <table className="gh-table">
                  <thead>
                    <tr>
                      <th>Decision</th>
                      <th>Actor</th>
                      <th>Owner</th>
                      <th>Ref</th>
                      <th>Commit</th>
                      <th>Policy Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pushes.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className={`gh-label ${p.allowed ? "gh-label-pass" : "gh-label-fail"}`}>
                            {p.allowed ? "Allowed" : "Blocked"}
                          </span>
                        </td>
                        <td>
                          <strong>{p.actorHandle}</strong>{" "}
                          <span className="muted">({p.actorType})</span>
                        </td>
                        <td className="muted">{p.ownerHandle ?? "—"}</td>
                        <td className="mono">{p.ref}</td>
                        <td className="mono muted">{p.newSha.slice(0, 7)}</td>
                        <td className="muted">{p.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="gh-box">
              <div className="gh-box-header">
                <span className="row">
                  <PulseIcon size={15} />
                  <span>Outgoing Webhook Deliveries</span>
                </span>
                <span className="muted tabular">{deliveries.length} deliveries</span>
              </div>
              {deliveries.length === 0 ? (
                <div style={{ padding: 24 }} className="muted">
                  No outgoing webhooks dispatched yet.
                </div>
              ) : (
                <table className="gh-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Event</th>
                      <th>Destination URL</th>
                      <th>Subscription</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <span className={`gh-label ${d.error ? "gh-label-fail" : "gh-label-pass"} tabular`}>
                            {d.statusCode ?? "ERR"}
                          </span>
                        </td>
                        <td className="mono">{d.event}</td>
                        <td className="mono muted">{d.url}</td>
                        <td className="mono muted">{d.subscriptionId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        ) : repoTab === "settings" && currentRepo ? (
          <div className="stack" style={{ gap: 20 }}>
            <section className="gh-box">
              <div className="gh-box-header">
                <span className="row">
                  <ShieldIcon size={15} />
                  <span>Merge Gate Policy — {currentRepo.slug}</span>
                </span>
                <span className="gh-label gh-label-neutral">
                  Credential mode: {currentRepo.credentialMode}
                </span>
              </div>
              <table className="gh-table">
                <tbody>
                  <tr>
                    <td style={{ width: 240 }} className="muted">Protected branches</td>
                    <td className="mono">{currentRepo.protectedBranches.join(", ")}</td>
                  </tr>
                  <tr>
                    <td className="muted">Upstream forge</td>
                    <td className="mono">
                      {currentRepo.forgeType} · {currentRepo.upstreamRepo}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Required CI checks</td>
                    <td className="mono">
                      {currentRepo.mergePolicy.requireCiPassed
                        ? currentRepo.mergePolicy.requiredChecks.join(", ") || "All checks"
                        : "Not required"}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Required approvers</td>
                    <td>
                      Min <strong className="tabular">{currentRepo.mergePolicy.minApprovals}</strong>
                      {currentRepo.mergePolicy.requiredApprovers.length > 0 && (
                        <> · Must include: <code>{currentRepo.mergePolicy.requiredApprovers.join(", ")}</code></>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Diff filter rules</td>
                    <td>
                      {currentRepo.diffFilterRules.length === 0 ? (
                        <span className="muted">None configured</span>
                      ) : (
                        currentRepo.diffFilterRules.map((r) => (
                          <div key={r.id} style={{ marginBottom: 4 }}>
                            <strong>{r.name}</strong> — hide <code>{r.filePatterns.join(", ")}</code>{" "}
                            for {r.hideForActorTypes.join(", ")}{" "}
                            {r.whenAgentApproved && <>once <code>{r.whenAgentApproved}</code> approves</>}
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="gh-box">
              <div className="gh-box-header">
                <span className="row">
                  <BotIcon size={15} />
                  <span>Registered Agent Bots</span>
                </span>
                <span className="muted tabular">{agents.length} bots</span>
              </div>
              <table className="gh-table">
                <thead>
                  <tr>
                    <th>Handle</th>
                    <th>Display Name</th>
                    <th>Allowed Branches</th>
                    <th>Can Approve</th>
                    <th>Can Merge</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        ) : selectedPrNum === null || !prDetail ? (
          /* GitHub Pull Request List View */
          <section className="gh-box">
            <div className="gh-box-header">
              <span className="row">
                <GitPullRequestIcon size={15} />
                <span>{prs.filter((p) => p.status === "open").length} Open</span>
                <span className="muted">
                  · {prs.filter((p) => p.status === "merged").length} Merged
                </span>
              </span>
              <span className="muted">{selectedSlug}</span>
            </div>
            {prs.length === 0 ? (
              <div style={{ padding: 36, textAlign: "center" }} className="muted">
                No pull requests yet. Push a branch and run <code>agit pr create</code> to open one.
              </div>
            ) : (
              prs.map((p) => (
                <div
                  key={p.id}
                  className="gh-pr-row"
                  onClick={() => {
                    setSelectedPrNum(p.number);
                    setPrTab("conversation");
                  }}
                >
                  <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                    <span
                      style={{
                        marginTop: 3,
                        color:
                          p.status === "merged"
                            ? "var(--gh-done-fg)"
                            : p.status === "open"
                              ? "var(--gh-success-fg)"
                              : "var(--gh-danger-fg)",
                      }}
                    >
                      {p.status === "merged" ? (
                        <GitMergeIcon size={16} />
                      ) : (
                        <GitPullRequestIcon size={16} />
                      )}
                    </span>
                    <div>
                      <div className="gh-pr-row-title">{p.title}</div>
                      <div className="gh-pr-row-meta">
                        <span className="tabular">#{p.number}</span>
                        <span>
                          opened by <strong>{p.authorHandle}</strong> ({p.authorType}
                          {p.authorOwnerHandle ? ` · owner: ${p.authorOwnerHandle}` : ""})
                        </span>
                        <span className="gh-branch-pill">{p.sourceBranch}</span>
                        <span>→</span>
                        <span className="gh-branch-pill">{p.targetBranch}</span>
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    {p.autoMerge && <span className="gh-label gh-label-purple">Auto-merge</span>}
                    <span
                      className={`gh-label ${
                        p.status === "merged" || p.gate.canMerge ? "gh-label-pass" : "gh-label-fail"
                      }`}
                    >
                      {p.status === "merged" ? "Merged" : p.gate.canMerge ? "Ready" : "Gated"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>
        ) : (
          /* GitHub Pull Request Detail View */
          <div>
            {/* Back link when multiple PRs exist */}
            {prs.length > 1 && (
              <div style={{ marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSelectedPrNum(null)}
                >
                  ← All pull requests ({prs.length})
                </button>
              </div>
            )}

            {/* PR Title & Status Subtitle */}
            <div className="gh-pr-header">
              <div className="gh-pr-title-row">
                <h1 className="gh-pr-title">
                  {prDetail.pr.title}
                  <span className="gh-pr-number tabular">#{prDetail.pr.number}</span>
                </h1>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleReview("approved")}
                  >
                    <CheckCircleIcon size={14} />
                    <span>Approve</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => handleReview("changes_requested")}
                  >
                    <XCircleIcon size={14} />
                    <span>Request changes</span>
                  </button>
                </div>
              </div>

              <div className="gh-pr-subtitle">
                <span className={`gh-state-pill ${prDetail.pr.status}`}>
                  {prDetail.pr.status === "merged" ? (
                    <GitMergeIcon size={14} />
                  ) : (
                    <GitPullRequestIcon size={14} />
                  )}
                  <span>
                    {prDetail.pr.status === "open"
                      ? "Open"
                      : prDetail.pr.status === "merged"
                        ? "Merged"
                        : "Closed"}
                  </span>
                </span>
                <span>
                  <strong style={{ color: "var(--gh-fg-default)" }}>{prDetail.pr.authorHandle}</strong>
                  {prDetail.pr.authorType === "agent" && (
                    <>
                      {" "}
                      <span className="gh-label gh-label-bot">bot</span>
                      {prDetail.pr.authorOwnerHandle && (
                        <span> (owner: {prDetail.pr.authorOwnerHandle})</span>
                      )}
                    </>
                  )}{" "}
                  wants to merge into{" "}
                  <span className="gh-branch-pill">{prDetail.pr.targetBranch}</span> from{" "}
                  <span className="gh-branch-pill">{prDetail.pr.sourceBranch}</span>
                </span>
                <span className="mono muted">({prDetail.pr.headSha.slice(0, 7)})</span>
              </div>
            </div>

            {/* GitHub PR Sub-Tabs */}
            <div className="gh-pr-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={prTab === "conversation"}
                className={`gh-pr-tab ${prTab === "conversation" ? "active" : ""}`}
                onClick={() => setPrTab("conversation")}
              >
                <CommentIcon size={15} />
                <span>Conversation</span>
                <span className="gh-counter">{prDetail.comments.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={prTab === "checks"}
                className={`gh-pr-tab ${prTab === "checks" ? "active" : ""}`}
                onClick={() => setPrTab("checks")}
              >
                <ShieldIcon size={15} />
                <span>Checks & Gate</span>
                <span className="gh-counter">{prDetail.gate.ci.checks.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={prTab === "files"}
                className={`gh-pr-tab ${prTab === "files" ? "active" : ""}`}
                onClick={() => setPrTab("files")}
              >
                <FileDiffIcon size={15} />
                <span>Files changed</span>
                <span className="gh-counter">{totalChangedFiles}</span>
                {diffData && diffData.hiddenFiles.length > 0 && !includeHidden && (
                  <span className="gh-label gh-label-purple">
                    {diffData.hiddenFiles.length} hidden by agent
                  </span>
                )}
              </button>
            </div>

            {/* TAB 1: CONVERSATION (Two-Column GitHub PR Layout) */}
            {prTab === "conversation" && (
              <div className="gh-pr-layout">
                <div className="gh-timeline">
                  {/* PR Description Box */}
                  <div className="gh-timeline-item">
                    <span className={`gh-avatar ${prDetail.pr.authorType}`}>
                      {initials(prDetail.pr.authorHandle)}
                    </span>
                    <div className="gh-comment-box">
                      <div className="gh-comment-head">
                        <div className="gh-comment-head-left">
                          <strong>{prDetail.pr.authorHandle}</strong>
                          {prDetail.pr.authorType === "agent" && (
                            <span className="gh-label gh-label-bot">bot</span>
                          )}
                          <span className="muted">opened this pull request</span>
                        </div>
                        <span className="gh-label gh-label-neutral">Author</span>
                      </div>
                      <div className="gh-comment-body">
                        {prDetail.pr.description || (
                          <span className="muted">No description provided.</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Reviews & Typed Comments Timeline */}
                  {timelineItems.map((item) => {
                    if (item.kind === "review") {
                      const rv = item.data;
                      return (
                        <div className="gh-timeline-item" key={rv.id}>
                          <span className={`gh-avatar ${rv.actorType}`}>
                            {initials(rv.actorHandle)}
                          </span>
                          <div className="gh-comment-box">
                            <div className="gh-comment-head">
                              <div className="gh-comment-head-left">
                                {rv.status === "approved" ? (
                                  <span style={{ color: "var(--gh-success-fg)", display: "inline-flex" }}>
                                    <CheckCircleIcon size={15} />
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--gh-danger-fg)", display: "inline-flex" }}>
                                    <XCircleIcon size={15} />
                                  </span>
                                )}
                                <strong>{rv.actorHandle}</strong>
                                {rv.actorType === "agent" && (
                                  <span className="gh-label gh-label-bot">bot</span>
                                )}
                                <span className="muted">
                                  {rv.status === "approved"
                                    ? "approved these changes"
                                    : rv.status === "changes_requested"
                                      ? "requested changes"
                                      : "reviewed"}
                                </span>
                              </div>
                              <span className="mono muted">{rv.commitSha.slice(0, 7)}</span>
                            </div>
                            {rv.body && <div className="gh-comment-body">{rv.body}</div>}
                          </div>
                        </div>
                      );
                    }

                    const c = item.data;
                    return (
                      <div className="gh-timeline-item" key={c.id}>
                        <span className={`gh-avatar ${c.authorType}`}>
                          {initials(c.authorHandle)}
                        </span>
                        <div className={`gh-comment-box ${c.resolved ? "resolved" : ""}`}>
                          <div className="gh-comment-head">
                            <div className="gh-comment-head-left">
                              <strong>{c.authorHandle}</strong>
                              {c.authorType === "agent" && (
                                <span className="gh-label gh-label-bot">bot</span>
                              )}
                              <span
                                className="gh-label"
                                style={{
                                  background: c.commentTypeMeta?.color ?? "#475569",
                                  color: "#ffffff",
                                }}
                              >
                                {c.commentTypeMeta?.label ?? c.commentType}
                              </span>
                              {c.filePath && (
                                <code className="muted">
                                  {c.filePath}
                                  {c.line ? `:${c.line}` : ""}
                                </code>
                              )}
                              {c.resolved && (
                                <span className="gh-label gh-label-pass">
                                  Resolved{c.resolvedByHandle ? ` by ${c.resolvedByHandle}` : ""}
                                </span>
                              )}
                            </div>
                            <div className="row">
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => handleInvokeAgent(undefined, c.id)}
                              >
                                <PlayIcon size={13} />
                                <span>Send to Agent</span>
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => handleResolveComment(c.id, c.resolved)}
                              >
                                {c.resolved ? "Reopen" : "Resolve"}
                              </button>
                            </div>
                          </div>
                          <div className="gh-comment-body">{c.body}</div>
                          {c.commentTypeMeta?.agentInstruction && (
                            <div className="gh-comment-directive">
                              <BotIcon size={14} />
                              <span>
                                <strong>Agent directive:</strong> {c.commentTypeMeta.agentInstruction}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Iconic GitHub Merge Box */}
                  <div className={`gh-merge-box ${prDetail.gate.canMerge ? "ready" : ""}`}>
                    <div className="gh-merge-row">
                      <span
                        className={`gh-merge-icon ${prDetail.gate.ci.passed ? "pass" : "fail"}`}
                      >
                        {prDetail.gate.ci.passed ? (
                          <CheckCircleIcon size={18} />
                        ) : (
                          <XCircleIcon size={18} />
                        )}
                      </span>
                      <div>
                        <div className="gh-merge-row-title">
                          {prDetail.gate.ci.passed
                            ? "All upstream CI checks have passed"
                            : "Upstream CI checks pending or failed"}
                        </div>
                        <div className="gh-merge-row-sub">
                          {prDetail.gate.ci.checks.length > 0
                            ? prDetail.gate.ci.checks
                                .map((ch) => `${ch.name}: ${ch.status}`)
                                .join(" · ")
                            : prDetail.gate.ci.missingChecks.length > 0
                              ? `Waiting on required checks: ${prDetail.gate.ci.missingChecks.join(", ")}`
                              : "No checks reported yet"}
                        </div>
                      </div>
                    </div>

                    <div className="gh-merge-row">
                      <span
                        className={`gh-merge-icon ${prDetail.gate.approvals.passed ? "pass" : "warn"}`}
                      >
                        {prDetail.gate.approvals.passed ? (
                          <CheckCircleIcon size={18} />
                        ) : (
                          <ClockIcon size={18} />
                        )}
                      </span>
                      <div>
                        <div className="gh-merge-row-title">
                          {prDetail.gate.approvals.passed
                            ? "All custom approval requirements satisfied"
                            : "Review required by custom merge policy"}
                        </div>
                        <div className="gh-merge-row-sub">
                          Approved ({prDetail.gate.approvals.approvedHandles.length}/
                          {prDetail.gate.approvals.minApprovals}):{" "}
                          {prDetail.gate.approvals.approvedHandles.join(", ") || "none"}
                          {prDetail.gate.approvals.missingRequiredApprovers.length > 0 && (
                            <>
                              {" "}
                              · Waiting on:{" "}
                              <strong>
                                {prDetail.gate.approvals.missingRequiredApprovers.join(", ")}
                              </strong>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="gh-merge-row">
                      <span
                        className={`gh-merge-icon ${prDetail.gate.comments.passed ? "pass" : "fail"}`}
                      >
                        {prDetail.gate.comments.passed ? (
                          <CheckCircleIcon size={18} />
                        ) : (
                          <XCircleIcon size={18} />
                        )}
                      </span>
                      <div>
                        <div className="gh-merge-row-title">
                          {prDetail.gate.comments.passed
                            ? "No unresolved blocking comments"
                            : `${prDetail.gate.comments.unresolvedBlockingIds.length} unresolved blocking comment(s)`}
                        </div>
                        <div className="gh-merge-row-sub">
                          {prDetail.gate.comments.deferredCount} deferred to next PR (non-blocking)
                          {prDetail.gate.comments.unresolvedErrorFindingIds.length > 0 &&
                            ` · ${prDetail.gate.comments.unresolvedErrorFindingIds.length} error agent finding(s)`}
                        </div>
                      </div>
                    </div>

                    <div className="gh-merge-footer">
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!prDetail.gate.canMerge || prDetail.pr.status !== "open"}
                          onClick={handleMerge}
                        >
                          <GitMergeIcon size={15} />
                          <span>
                            {prDetail.pr.status === "merged"
                              ? "Pull request merged"
                              : "Merge pull request"}
                          </span>
                        </button>
                        {prDetail.pr.status === "open" && (
                          <button type="button" className="btn" onClick={handleToggleAutoMerge}>
                            {prDetail.pr.autoMerge ? "Disable auto-merge" : "Enable auto-merge"}
                          </button>
                        )}
                      </div>
                      {prDetail.pr.autoMerge && prDetail.pr.status === "open" && (
                        <span className="gh-label gh-label-purple">
                          Auto-merge armed — merges immediately when all gates turn green
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Typed Comment Composer */}
                  <form className="gh-comment-box" onSubmit={handlePostComment} style={{ zIndex: 1 }}>
                    <div className="gh-comment-head">
                      <div className="row">
                        <strong>Add typed review comment</strong>
                        <select
                          aria-label="Comment type"
                          className="select"
                          value={commentType}
                          onChange={(e) => setCommentType(e.target.value)}
                        >
                          {prDetail.commentTypes.map((ct) => (
                            <option key={ct.key} value={ct.key}>
                              {ct.label} ({ct.blocksMerge ? "blocks merge" : "non-blocking"})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="row">
                        <input
                          className="input mono"
                          style={{ width: 170 }}
                          value={commentFile}
                          onChange={(e) => setCommentFile(e.target.value)}
                          placeholder="File (e.g. src/index.js)"
                        />
                        <input
                          className="input mono"
                          style={{ width: 74 }}
                          value={commentLine}
                          onChange={(e) => setCommentLine(e.target.value)}
                          placeholder="Line"
                        />
                      </div>
                    </div>
                    <div style={{ padding: 14 }}>
                      <textarea
                        rows={3}
                        className="textarea"
                        style={{ width: "100%", marginBottom: 10 }}
                        value={commentBody}
                        onChange={(e) => setCommentBody(e.target.value)}
                        placeholder="Leave structured feedback for humans or agents..."
                      />
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {selectedCommentTypeDef?.agentInstruction}
                        </span>
                        <button type="submit" className="btn btn-primary">
                          Comment
                        </button>
                      </div>
                    </div>
                  </form>
                </div>

                {/* Right Sticky Metadata Rail */}
                <aside className="gh-sidebar-rail">
                  <div className="gh-rail-section">
                    <div className="gh-rail-heading">
                      <span>Reviewers & Agents</span>
                      <BotIcon size={14} />
                    </div>
                    {prDetail.pr.assignedAgents.length === 0 ? (
                      <div className="muted" style={{ fontSize: 12 }}>No agents assigned</div>
                    ) : (
                      prDetail.pr.assignedAgents.map((handle) => {
                        const approved = prDetail.gate.approvals.approvedHandles.includes(handle);
                        return (
                          <div className="gh-rail-row" key={handle}>
                            <span className="row" style={{ gap: 6 }}>
                              <span className="gh-avatar gh-avatar-sm agent">
                                {initials(handle)}
                              </span>
                              <span>{handle}</span>
                            </span>
                            <span
                              style={{
                                color: approved
                                  ? "var(--gh-success-fg)"
                                  : "var(--gh-attention-fg)",
                                display: "inline-flex",
                              }}
                              title={approved ? "Approved" : "Pending review"}
                            >
                              {approved ? <CheckCircleIcon size={15} /> : <ClockIcon size={15} />}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="gh-rail-section">
                    <div className="gh-rail-heading">
                      <span>Invoke Agentic App</span>
                      <PlayIcon size={14} />
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      <select
                        aria-label="Target agent"
                        className="select"
                        value={invokeAgentHandle}
                        onChange={(e) => setInvokeAgentHandle(e.target.value)}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.handle}>
                            {a.handle}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input"
                        value={invokePrompt}
                        onChange={(e) => setInvokePrompt(e.target.value)}
                        placeholder="Prompt sent via webhook..."
                      />
                      <button
                        type="button"
                        className="btn btn-accent"
                        onClick={() => handleInvokeAgent()}
                      >
                        <PlayIcon size={14} />
                        <span>Invoke agent</span>
                      </button>
                    </div>
                  </div>

                  <div className="gh-rail-section">
                    <div className="gh-rail-heading">
                      <span>Agent Diff Filters</span>
                      <EyeOffIcon size={14} />
                    </div>
                    {diffData && diffData.hiddenFiles.length > 0 ? (
                      <div className="stack" style={{ gap: 6, fontSize: 12 }}>
                        {diffData.hiddenFiles.map((hf) => (
                          <div key={hf.path} className="muted">
                            <code style={{ color: "var(--gh-fg-default)" }}>{hf.path}</code>
                            <div>Covered by {hf.coveredByAgent}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>
                        No files currently hidden for {me.actor.handle}.
                      </div>
                    )}
                  </div>

                  <div className="gh-rail-section">
                    <div className="gh-rail-heading">
                      <span>Upstream Shadow PR</span>
                      <GitBranchIcon size={14} />
                    </div>
                    <div className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                      {prDetail.pr.upstreamPrId
                        ? `${currentRepo?.forgeType ?? "upstream"} #${prDetail.pr.upstreamPrId}`
                        : "Local only"}
                    </div>
                  </div>
                </aside>
              </div>
            )}

            {/* TAB 2: CHECKS & GATE */}
            {prTab === "checks" && (
              <div className="stack" style={{ gap: 16 }}>
                <section className="gh-box">
                  <div className="gh-box-header">
                    <span>Upstream CI Checks</span>
                    <span
                      className={`gh-label ${prDetail.gate.ci.passed ? "gh-label-pass" : "gh-label-fail"}`}
                    >
                      {prDetail.gate.ci.passed ? "Passing" : "Pending / Failed"}
                    </span>
                  </div>
                  <table className="gh-table">
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Status</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prDetail.gate.ci.checks.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="muted">
                            No upstream CI checks reported yet.
                          </td>
                        </tr>
                      ) : (
                        prDetail.gate.ci.checks.map((ch) => (
                          <tr key={ch.name}>
                            <td className="mono">{ch.name}</td>
                            <td>
                              <span
                                className={`gh-label ${ch.status === "passed" ? "gh-label-pass" : "gh-label-fail"}`}
                              >
                                {ch.status}
                              </span>
                            </td>
                            <td className="muted tabular">{ch.updatedAt}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </section>

                <section className="gh-box">
                  <div className="gh-box-header">
                    <span>Merge Gate Checklist</span>
                    <span
                      className={`gh-label ${prDetail.gate.canMerge ? "gh-label-pass" : "gh-label-fail"}`}
                    >
                      {prDetail.gate.canMerge ? "Ready to merge" : "Blocked"}
                    </span>
                  </div>
                  <div style={{ padding: 16 }}>
                    {prDetail.gate.reasons.length === 0 ? (
                      <div style={{ color: "var(--gh-success-fg)" }}>
                        All merge conditions are satisfied.
                      </div>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {prDetail.gate.reasons.map((r, i) => (
                          <li key={i} style={{ marginBottom: 4 }}>
                            {r}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              </div>
            )}

            {/* TAB 3: FILES CHANGED (Authentic GitHub Diff + File Tree + Agent Filter) */}
            {prTab === "files" && diffData && (
              <div>
                <div className="gh-diff-toolbar">
                  <div className="row">
                    <strong>
                      Showing {diffData.visibleFiles.length} of {totalChangedFiles} changed file(s)
                    </strong>
                    <span className="gh-diffstat">
                      <span className="adds">+{totalDiffStats.additions}</span>
                      <span className="dels">−{totalDiffStats.deletions}</span>
                    </span>
                    <span className="muted">
                      Viewing as <strong>{diffData.viewerHandle}</strong> ({diffData.viewerType})
                    </span>
                  </div>
                  <div className="row">
                    {diffData.hiddenFiles.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setIncludeHidden((v) => !v)}
                      >
                        {includeHidden ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                        <span>
                          {includeHidden
                            ? `Hide ${diffData.hiddenFiles.length} agent-reviewed file(s)`
                            : `Show ${diffData.hiddenFiles.length} hidden file(s)`}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="gh-diff-layout">
                  {/* Left File Tree */}
                  <aside className="gh-file-tree" aria-label="Changed files">
                    <div className="gh-box-header" style={{ padding: "8px 12px" }}>
                      <span>Files</span>
                      <span className="muted tabular">{totalChangedFiles}</span>
                    </div>
                    {diffData.visibleFiles.map((f) => (
                      <a
                        key={f.path}
                        href={`#diff-${encodeURIComponent(f.path)}`}
                        className="gh-file-tree-item"
                        style={{ textDecoration: "none" }}
                      >
                        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {f.path}
                        </span>
                        <span className="gh-diffstat">
                          <span className="adds">+{f.additions}</span>
                        </span>
                      </a>
                    ))}
                    {!includeHidden &&
                      diffData.hiddenFiles.map((hf) => (
                        <button
                          key={hf.path}
                          type="button"
                          className="gh-file-tree-item hidden-file"
                          onClick={() => setIncludeHidden(true)}
                          title={hf.reason}
                        >
                          <span className="row" style={{ gap: 6, minWidth: 0 }}>
                            <EyeOffIcon size={13} />
                            <span
                              className="mono"
                              style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                            >
                              {hf.path}
                            </span>
                          </span>
                          <span className="gh-label gh-label-purple">agent</span>
                        </button>
                      ))}
                  </aside>

                  {/* Right Diff Panels */}
                  <div>
                    {diffData.hiddenFiles.length > 0 && !includeHidden && (
                      <div className="gh-hidden-notice">
                        <div className="row" style={{ gap: 10 }}>
                          <EyeOffIcon size={18} />
                          <div>
                            <strong>
                              {diffData.hiddenFiles.length} file(s) hidden by agent diff filter
                            </strong>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {diffData.hiddenFiles.map((hf) => (
                                <div key={hf.path}>
                                  <code>{hf.path}</code> (+{hf.additions}/−{hf.deletions}) —{" "}
                                  {hf.reason}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setIncludeHidden(true)}
                        >
                          Show hidden files anyway
                        </button>
                      </div>
                    )}

                    {diffData.visibleFiles.map((f) => {
                      const rows = parseUnifiedPatch(f.patch);
                      const fileComments = prDetail.comments.filter((c) => c.filePath === f.path);
                      const unanchoredFileComments = fileComments.filter((c) => !c.line);

                      return (
                        <section
                          className="gh-diff-file"
                          key={f.path}
                          id={`diff-${encodeURIComponent(f.path)}`}
                        >
                          <div className="gh-diff-file-header">
                            <div className="row">
                              <FileDiffIcon size={15} className="muted" />
                              <code style={{ fontWeight: 600 }}>{f.path}</code>
                              <span className="gh-label gh-label-neutral">{f.status}</span>
                            </div>
                            <span className="gh-diffstat">
                              <span className="adds">+{f.additions}</span>
                              <span className="dels">−{f.deletions}</span>
                            </span>
                          </div>

                          <div className="gh-diff-table-wrap">
                            <table className="gh-diff-table">
                              <tbody>
                                {rows.map((row, idx) => {
                                  const lineComments =
                                    row.newLine !== null
                                      ? fileComments.filter((c) => c.line === row.newLine)
                                      : [];
                                  return (
                                    <React.Fragment key={idx}>
                                      <tr className={`gh-diff-row ${row.kind}`}>
                                        <td className="gh-diff-num">{row.oldLine ?? ""}</td>
                                        <td className="gh-diff-num">{row.newLine ?? ""}</td>
                                        <td className="gh-diff-code">
                                          {row.prefix}
                                          {row.content}
                                        </td>
                                      </tr>
                                      {lineComments.map((lc) => (
                                        <tr key={lc.id} className="gh-inline-comment-row">
                                          <td colSpan={3}>
                                            <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                                              <div className="row">
                                                <strong>{lc.authorHandle}</strong>
                                                <span
                                                  className="gh-label"
                                                  style={{
                                                    background: lc.commentTypeMeta?.color ?? "#475569",
                                                    color: "#ffffff",
                                                  }}
                                                >
                                                  {lc.commentTypeMeta?.label ?? lc.commentType}
                                                </span>
                                              </div>
                                              <button
                                                type="button"
                                                className="btn btn-sm"
                                                onClick={() => handleResolveComment(lc.id, lc.resolved)}
                                              >
                                                {lc.resolved ? "Reopen" : "Resolve"}
                                              </button>
                                            </div>
                                            <div>{lc.body}</div>
                                          </td>
                                        </tr>
                                      ))}
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {unanchoredFileComments.length > 0 && (
                            <div
                              style={{
                                borderTop: "1px solid var(--gh-border-default)",
                                background: "var(--gh-canvas-subtle)",
                                padding: "10px 14px",
                              }}
                            >
                              {unanchoredFileComments.map((fc) => (
                                <div key={fc.id} style={{ marginBottom: 6 }}>
                                  <span
                                    className="gh-label"
                                    style={{
                                      background: fc.commentTypeMeta?.color ?? "#475569",
                                      color: "#ffffff",
                                      marginRight: 8,
                                    }}
                                  >
                                    {fc.commentTypeMeta?.label ?? fc.commentType}
                                  </span>
                                  <strong>{fc.authorHandle}:</strong> {fc.body}
                                </div>
                              ))}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
