import React, { useCallback, useEffect, useState } from "react";
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

interface PrDetailPayload {
  pr: PullRequest;
  comments: PrComment[];
  reviews: PrReview[];
  commentTypes: CommentTypeDefinition[];
  gate: MergeGateResult;
}

export function App() {
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("agit_server") || window.location.origin,
  );
  const [token, setToken] = useState(() => localStorage.getItem("agit_token") || "");
  const [me, setMe] = useState<{ actor: Actor; owner: Actor | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [prs, setPrs] = useState<Array<PullRequest & { gate: MergeGateResult }>>([]);
  const [selectedPrNum, setSelectedPrNum] = useState<number | null>(null);
  const [prDetail, setPrDetail] = useState<PrDetailPayload | null>(null);
  const [diffData, setDiffData] = useState<FilteredDiffResponse | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [agents, setAgents] = useState<Actor[]>([]);
  const [pushes, setPushes] = useState<PushAuditEntry[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [activeTab, setActiveTab] = useState<"diff" | "comments" | "audit">("diff");

  // Comment form state
  const [commentType, setCommentType] = useState("blocking");
  const [commentBody, setCommentBody] = useState("");
  const [commentFile, setCommentFile] = useState("");
  const [invokeAgentHandle, setInvokeAgentHandle] = useState("");
  const [invokePrompt, setInvokePrompt] = useState("");

  const apiFetch = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      return json as T;
    },
    [serverUrl, token],
  );

  const loadWorkspace = useCallback(async () => {
    if (!token) return;
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

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("agit_server", serverUrl);
    localStorage.setItem("agit_token", token);
    void loadWorkspace();
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug || selectedPrNum === null || !commentBody.trim()) return;
    await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/comments`, {
      method: "POST",
      body: JSON.stringify({
        commentType,
        body: commentBody.trim(),
        filePath: commentFile.trim() || null,
      }),
    });
    setCommentBody("");
    setCommentFile("");
    await loadPrDetail();
    await loadRepoData();
  };

  const handleResolveComment = async (id: string, resolved: boolean) => {
    await apiFetch(`/api/comments/${id}/${resolved ? "reopen" : "resolve"}`, {
      method: "POST",
    });
    await loadPrDetail();
    await loadRepoData();
  };

  const handleReview = async (status: "approved" | "changes_requested") => {
    if (!selectedSlug || selectedPrNum === null) return;
    await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/reviews`, {
      method: "POST",
      body: JSON.stringify({ status, body: `Submitted ${status} via web UI` }),
    });
    await loadPrDetail();
    await loadRepoData();
  };

  const handleMerge = async () => {
    if (!selectedSlug || selectedPrNum === null) return;
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/merge`, {
        method: "POST",
      });
      await loadPrDetail();
      await loadRepoData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInvokeAgent = async (commentId?: string) => {
    if (!selectedSlug || selectedPrNum === null || !invokeAgentHandle) return;
    await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/invoke-agent`, {
      method: "POST",
      body: JSON.stringify({
        agentHandle: invokeAgentHandle,
        commentId: commentId ?? null,
        prompt: invokePrompt || "Please inspect this PR/comment and respond.",
      }),
    });
    setInvokePrompt("");
    await loadRepoData();
  };

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <span>agentic-git</span>
          {me && (
            <span className="badge neutral">
              {me.actor.handle} ({me.actor.type}
              {me.owner ? ` · owner: ${me.owner.handle}` : ""})
            </span>
          )}
        </div>
        <form className="auth-bar" onSubmit={handleConnect}>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="Server URL"
            style={{ width: 200 }}
          />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Actor or Bot Token (agit_...)"
            style={{ width: 260 }}
          />
          <button type="submit">Connect</button>
        </form>
      </header>

      {error && (
        <div style={{ padding: "10px 20px", background: "rgba(239,68,68,0.18)", color: "#fca5a5" }}>
          {error}
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              REPOSITORIES
            </div>
            {repos.map((r) => (
              <div
                key={r.id}
                className={`list-item ${r.slug === selectedSlug ? "active" : ""}`}
                onClick={() => {
                  setSelectedSlug(r.slug);
                  setSelectedPrNum(null);
                }}
              >
                <div style={{ fontWeight: 600 }}>{r.slug}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.forgeType} · {r.upstreamRepo}
                </div>
              </div>
            ))}
          </div>

          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              PULL REQUESTS
            </div>
            {prs.map((p) => (
              <div
                key={p.id}
                className={`list-item ${p.number === selectedPrNum ? "active" : ""}`}
                onClick={() => setSelectedPrNum(p.number)}
              >
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>#{p.number}</strong>
                  <span className={`badge ${p.status === "merged" || p.gate.canMerge ? "pass" : "fail"}`}>
                    {p.status === "merged" ? "MERGED" : p.gate.canMerge ? "READY" : "GATED"}
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>{p.title}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  by {p.authorHandle} ({p.authorType})
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className="main">
          {!me ? (
            <div className="card">
              <h3>Connect to agentic-git</h3>
              <p className="muted">
                Enter your human or agent bot token above to inspect agent-filtered diffs, typed
                comments, custom merge gates, and push attribution.
              </p>
            </div>
          ) : !prDetail ? (
            <div className="card">
              <h3>Select a Pull Request</h3>
              <p className="muted">Pick a repository and PR on the left to begin reviewing.</p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <h2 style={{ margin: "0 0 4px" }}>
                      #{prDetail.pr.number} {prDetail.pr.title}
                    </h2>
                    <div className="muted">
                      {prDetail.pr.sourceBranch} → {prDetail.pr.targetBranch} · HEAD{" "}
                      <code>{prDetail.pr.headSha.slice(0, 7)}</code> · Author:{" "}
                      <strong>{prDetail.pr.authorHandle}</strong> ({prDetail.pr.authorType}
                      {prDetail.pr.authorOwnerHandle
                        ? `, owner: ${prDetail.pr.authorOwnerHandle}`
                        : ""}
                      )
                    </div>
                  </div>
                  <div className="row">
                    <button className="success" onClick={() => handleReview("approved")}>
                      Approve
                    </button>
                    <button className="danger" onClick={() => handleReview("changes_requested")}>
                      Request Changes
                    </button>
                    <button
                      disabled={!prDetail.gate.canMerge || prDetail.pr.status !== "open"}
                      onClick={handleMerge}
                    >
                      Merge PR
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3>Custom Merge Gate {prDetail.pr.autoMerge ? "· Auto-Merge Enabled" : ""}</h3>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className={`badge ${prDetail.gate.ci.passed ? "pass" : "fail"}`}>
                    CI: {prDetail.gate.ci.passed ? "PASS" : "BLOCKED"}
                  </span>
                  <span className={`badge ${prDetail.gate.approvals.passed ? "pass" : "fail"}`}>
                    Approvals: {prDetail.gate.approvals.approvedHandles.join(", ") || "none"}
                  </span>
                  <span className={`badge ${prDetail.gate.comments.passed ? "pass" : "fail"}`}>
                    Blocking Comments: {prDetail.gate.comments.unresolvedBlockingIds.length}
                  </span>
                  <span className="badge neutral">
                    Deferred to Next PR: {prDetail.gate.comments.deferredCount}
                  </span>
                </div>
                {prDetail.gate.reasons.length > 0 && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} className="muted">
                    {prDetail.gate.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="tabs">
                <button
                  className={activeTab === "diff" ? "" : "secondary"}
                  onClick={() => setActiveTab("diff")}
                >
                  Agent-Filtered Diff ({diffData?.visibleFiles.length ?? 0} visible /{" "}
                  {diffData?.hiddenFiles.length ?? 0} hidden)
                </button>
                <button
                  className={activeTab === "comments" ? "" : "secondary"}
                  onClick={() => setActiveTab("comments")}
                >
                  Typed Comments ({prDetail.comments.length})
                </button>
                <button
                  className={activeTab === "audit" ? "" : "secondary"}
                  onClick={() => setActiveTab("audit")}
                >
                  Push Attribution & Webhooks ({pushes.length})
                </button>
              </div>

              {activeTab === "diff" && diffData && (
                <div>
                  {diffData.hiddenFiles.length > 0 && (
                    <div className="hidden-banner">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div>
                          <strong>
                            {diffData.hiddenFiles.length} file(s) hidden by agent diff-filter rules
                          </strong>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {diffData.hiddenFiles.map((hf) => (
                              <div key={hf.path}>
                                <code>{hf.path}</code> (+{hf.additions}/-{hf.deletions}) —{" "}
                                {hf.reason}
                              </div>
                            ))}
                          </div>
                        </div>
                        <button
                          className="secondary"
                          onClick={() => setIncludeHidden((v) => !v)}
                        >
                          {includeHidden ? "Hide agent-reviewed files" : "Show hidden files anyway"}
                        </button>
                      </div>
                    </div>
                  )}

                  {diffData.visibleFiles.map((f) => (
                    <div className="diff-box" key={f.path}>
                      <div className="diff-header">
                        <span>{f.path}</span>
                        <span className="muted">
                          {f.status} (+{f.additions}/-{f.deletions})
                        </span>
                      </div>
                      <div>
                        {f.patch.split("\n").map((line, idx) => {
                          const cls = line.startsWith("@@")
                            ? "hunk"
                            : line.startsWith("+") && !line.startsWith("+++")
                              ? "add"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "del"
                                : "";
                          return (
                            <div key={idx} className={`diff-line ${cls}`}>
                              {line}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "comments" && (
                <div>
                  <div className="card">
                    <h3>Invoke External Agent</h3>
                    <div className="row">
                      <select
                        value={invokeAgentHandle}
                        onChange={(e) => setInvokeAgentHandle(e.target.value)}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.handle}>
                            {a.handle} ({a.displayName})
                          </option>
                        ))}
                      </select>
                      <input
                        style={{ flex: 1 }}
                        value={invokePrompt}
                        onChange={(e) => setInvokePrompt(e.target.value)}
                        placeholder="Instruction for agent (sent via agent.invoked webhook)"
                      />
                      <button onClick={() => handleInvokeAgent()}>Invoke Agent</button>
                    </div>
                  </div>

                  {prDetail.comments.map((c) => (
                    <div className="comment-card" key={c.id}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div className="row">
                          <span
                            className="badge"
                            style={{
                              background: c.commentTypeMeta?.color ?? "#475569",
                              color: "#fff",
                            }}
                          >
                            {c.commentTypeMeta?.label ?? c.commentType}
                          </span>
                          <strong>{c.authorHandle}</strong>
                          <span className="muted">({c.authorType})</span>
                          {c.filePath && (
                            <code>
                              {c.filePath}
                              {c.line ? `:${c.line}` : ""}
                            </code>
                          )}
                          <span className={`badge ${c.resolved ? "pass" : "neutral"}`}>
                            {c.resolved ? "RESOLVED" : "OPEN"}
                          </span>
                        </div>
                        <div className="row">
                          <button
                            className="secondary"
                            onClick={() => handleInvokeAgent(c.id)}
                          >
                            Send to Agent
                          </button>
                          <button
                            className="secondary"
                            onClick={() => handleResolveComment(c.id, c.resolved)}
                          >
                            {c.resolved ? "Reopen" : "Resolve"}
                          </button>
                        </div>
                      </div>
                      <div style={{ marginTop: 8 }}>{c.body}</div>
                      {c.commentTypeMeta?.agentInstruction && (
                        <div className="comment-directive">
                          Agent directive: {c.commentTypeMeta.agentInstruction}
                        </div>
                      )}
                    </div>
                  ))}

                  <form className="card" onSubmit={handlePostComment}>
                    <h3>Post Typed Comment</h3>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <select
                        value={commentType}
                        onChange={(e) => setCommentType(e.target.value)}
                      >
                        {prDetail.commentTypes.map((ct) => (
                          <option key={ct.key} value={ct.key}>
                            {ct.label} ({ct.blocksMerge ? "blocks merge" : "non-blocking"})
                          </option>
                        ))}
                      </select>
                      <input
                        value={commentFile}
                        onChange={(e) => setCommentFile(e.target.value)}
                        placeholder="Optional file path (e.g. src/app.ts)"
                      />
                    </div>
                    <textarea
                      rows={3}
                      style={{ width: "100%", marginBottom: 8 }}
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      placeholder="Write structured feedback..."
                    />
                    <button type="submit">Post Comment</button>
                  </form>
                </div>
              )}

              {activeTab === "audit" && (
                <div>
                  <div className="card">
                    <h3>Git Push Attribution Log</h3>
                    {pushes.map((p) => (
                      <div key={p.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className={`badge ${p.allowed ? "pass" : "fail"}`}>
                          {p.allowed ? "ALLOW" : "DENY"}
                        </span>{" "}
                        <strong>{p.actorHandle}</strong>{" "}
                        {p.ownerHandle && <span className="muted">(owner: {p.ownerHandle})</span>}{" "}
                        → <code>{p.ref}</code> <code>{p.newSha.slice(0, 7)}</code> —{" "}
                        <span className="muted">{p.reason}</span>
                      </div>
                    ))}
                  </div>
                  <div className="card">
                    <h3>Outgoing Webhook Deliveries</h3>
                    {deliveries.map((d) => (
                      <div key={d.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className={`badge ${d.error ? "fail" : "pass"}`}>
                          {d.statusCode ?? "ERR"}
                        </span>{" "}
                        <strong>{d.event}</strong> → <code>{d.url}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
