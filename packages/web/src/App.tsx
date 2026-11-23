import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Actor,
  CommentTypeDefinition,
  FilteredDiffResponse,
  MergeGateResult,
  MergeMethod,
  PrComment,
  PrReview,
  PullRequest,
  PushAuditEntry,
  Repo,
  WebhookDelivery,
  WebhookSubscription,
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
import { MarkdownView } from "./markdown";
import { buildRoute, parseRoute, type PrTab, type RepoTab } from "./routing";
import { SettingsPanel } from "./SettingsPanel";
import { groupCommentThreads } from "./threads";

interface PrDetailPayload {
  pr: PullRequest;
  comments: PrComment[];
  reviews: PrReview[];
  commentTypes: CommentTypeDefinition[];
  gate: MergeGateResult;
}

function initials(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}

export function App() {
  const initialRoute = useMemo(() => parseRoute(window.location.pathname), []);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("agit_theme");
    return saved === "light" ? "light" : "dark";
  });
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("agit_server") || window.location.origin,
  );
  const [token, setToken] = useState(() => localStorage.getItem("agit_token") || "");
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [liveRefresh, setLiveRefresh] = useState(true);

  const [me, setMe] = useState<{ actor: Actor; owner: Actor | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>(initialRoute.slug);
  const [repoTab, setRepoTab] = useState<RepoTab>(initialRoute.repoTab);
  const [prs, setPrs] = useState<Array<PullRequest & { gate: MergeGateResult }>>([]);
  const [prStatusFilter, setPrStatusFilter] = useState<"open" | "merged" | "closed" | "all">("all");
  const [selectedPrNum, setSelectedPrNum] = useState<number | null>(initialRoute.prNum);
  const [prTab, setPrTab] = useState<PrTab>(initialRoute.prTab);
  const [prDetail, setPrDetail] = useState<PrDetailPayload | null>(null);
  const [diffData, setDiffData] = useState<FilteredDiffResponse | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [agents, setAgents] = useState<Actor[]>([]);
  const [pushes, setPushes] = useState<PushAuditEntry[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);

  // New PR modal/inline drawer
  const [showNewPr, setShowNewPr] = useState(false);
  const [newPrTitle, setNewPrTitle] = useState("");
  const [newPrBody, setNewPrBody] = useState("");
  const [newPrHead, setNewPrHead] = useState("");
  const [newPrBase, setNewPrBase] = useState("");
  const [newPrAutoMerge, setNewPrAutoMerge] = useState(false);

  // Edit PR state
  const [editingPr, setEditingPr] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");

  // Conversation composer & threaded reply state
  const [commentType, setCommentType] = useState("blocking");
  const [commentBody, setCommentBody] = useState("");
  const [commentFile, setCommentFile] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyType, setReplyType] = useState("suggestion");

  // Inline diff line comment state
  const [inlineAnchor, setInlineAnchor] = useState<{ filePath: string; line: number } | null>(null);
  const [inlineType, setInlineType] = useState("blocking");
  const [inlineBody, setInlineBody] = useState("");

  // Agent invoke & assign
  const [invokeAgentHandle, setInvokeAgentHandle] = useState("");
  const [invokePrompt, setInvokePrompt] = useState("");

  const flashNotice = useCallback((msg: string) => {
    setStatusNotice(msg);
    window.setTimeout(() => setStatusNotice((cur) => (cur === msg ? null : cur)), 4500);
  }, []);

  const navigate = useCallback(
    (next: Partial<{ slug: string; repoTab: RepoTab; prNum: number | null; prTab: PrTab }>) => {
      const merged = {
        slug: next.slug !== undefined ? next.slug : selectedSlug,
        repoTab: next.repoTab !== undefined ? next.repoTab : repoTab,
        prNum: next.prNum !== undefined ? next.prNum : selectedPrNum,
        prTab: next.prTab !== undefined ? next.prTab : prTab,
      };
      setSelectedSlug(merged.slug);
      setRepoTab(merged.repoTab);
      setSelectedPrNum(merged.prNum);
      setPrTab(merged.prTab);
      const url = buildRoute(merged);
      if (window.location.pathname !== url) {
        window.history.pushState(null, "", url);
      }
    },
    [selectedSlug, repoTab, selectedPrNum, prTab],
  );

  useEffect(() => {
    const onPopState = () => {
      const parsed = parseRoute(window.location.pathname);
      setSelectedSlug(parsed.slug);
      setRepoTab(parsed.repoTab);
      setSelectedPrNum(parsed.prNum);
      setPrTab(parsed.prTab);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
        const firstSlug = reposRes.repos[0].slug;
        setSelectedSlug(firstSlug);
        const url = buildRoute({
          slug: firstSlug,
          repoTab: "pulls",
          prNum: null,
          prTab: "conversation",
        });
        if (window.location.pathname === "/") {
          window.history.replaceState(null, "", url);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMe(null);
    }
  }, [apiFetch, token, selectedSlug, invokeAgentHandle]);

  const loadRepoData = useCallback(async () => {
    if (!token || !selectedSlug) return;
    try {
      const [prsRes, pushesRes, webhooksRes, delivRes] = await Promise.all([
        apiFetch<{ prs: Array<PullRequest & { gate: MergeGateResult }> }>(
          `/api/repos/${selectedSlug}/prs`,
        ),
        apiFetch<{ pushes: PushAuditEntry[] }>(`/api/repos/${selectedSlug}/pushes`),
        apiFetch<{ webhooks: WebhookSubscription[] }>(`/api/repos/${selectedSlug}/webhooks`),
        apiFetch<{ deliveries: WebhookDelivery[] }>(`/api/webhooks/deliveries`),
      ]);
      setPrs(prsRes.prs);
      setPushes(pushesRes.pushes);
      setWebhooks(webhooksRes.webhooks);
      setDeliveries(delivRes.deliveries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiFetch, token, selectedSlug]);

  const loadPrDetail = useCallback(async () => {
    if (!token || !selectedSlug || selectedPrNum === null) {
      setPrDetail(null);
      setDiffData(null);
      return;
    }
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

  // Live auto-refresh polling every 5s when enabled
  useEffect(() => {
    if (!liveRefresh || !token || !selectedSlug) return;
    const id = window.setInterval(() => {
      void loadRepoData();
      if (selectedPrNum !== null) {
        void loadPrDetail();
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [liveRefresh, token, selectedSlug, selectedPrNum, loadRepoData, loadPrDetail]);

  const currentRepo = useMemo(
    () => repos.find((r) => r.slug === selectedSlug) ?? null,
    [repos, selectedSlug],
  );

  useEffect(() => {
    if (currentRepo?.mergePolicy.mergeMethod) {
      setMergeMethod(currentRepo.mergePolicy.mergeMethod);
    }
  }, [currentRepo]);

  const selectedCommentTypeDef = useMemo(
    () => prDetail?.commentTypes.find((ct) => ct.key === commentType) ?? null,
    [prDetail, commentType],
  );

  const visiblePrs = useMemo(() => {
    if (prStatusFilter === "all") return prs;
    return prs.filter((p) => p.status === prStatusFilter);
  }, [prs, prStatusFilter]);

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

  const commentThreads = useMemo(
    () => groupCommentThreads(prDetail?.comments ?? []),
    [prDetail?.comments],
  );

  // Combine reviews + top-level comment threads chronologically
  const timelineItems = useMemo(() => {
    if (!prDetail) return [];
    const items: Array<
      | { kind: "thread"; createdAt: string; data: ReturnType<typeof groupCommentThreads>[number] }
      | { kind: "review"; createdAt: string; data: PrReview }
    > = [
      ...commentThreads.map((t) => ({ kind: "thread" as const, createdAt: t.root.createdAt, data: t })),
      ...prDetail.reviews.map((r) => ({ kind: "review" as const, createdAt: r.createdAt, data: r })),
    ];
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return items;
  }, [prDetail, commentThreads]);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("agit_server", serverUrl);
    localStorage.setItem("agit_token", token);
    setAuthMenuOpen(false);
    void loadWorkspace();
  };

  const handleSyncUpstream = async () => {
    if (!selectedSlug) return;
    setError(null);
    try {
      const res = await apiFetch<{ imported: number; updated: number }>(
        `/api/repos/${selectedSlug}/sync`,
        { method: "POST" },
      );
      await loadRepoData();
      flashNotice(`Synced upstream: ${res.imported} imported, ${res.updated} updated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreatePr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug || !newPrTitle.trim() || !newPrHead.trim()) return;
    setError(null);
    try {
      const res = await apiFetch<{ pr: PullRequest }>(`/api/repos/${selectedSlug}/prs`, {
        method: "POST",
        body: JSON.stringify({
          title: newPrTitle.trim(),
          description: newPrBody.trim(),
          sourceBranch: newPrHead.trim(),
          targetBranch: newPrBase.trim() || undefined,
          autoMerge: newPrAutoMerge,
        }),
      });
      setShowNewPr(false);
      setNewPrTitle("");
      setNewPrBody("");
      setNewPrHead("");
      setNewPrBase("");
      await loadRepoData();
      navigate({ prNum: res.pr.number, prTab: "conversation" });
      flashNotice(`Opened PR #${res.pr.number}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePrEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug || selectedPrNum === null || !editTitle.trim()) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle.trim(), description: editDesc }),
      });
      setEditingPr(false);
      await Promise.all([loadPrDetail(), loadRepoData()]);
      flashNotice(`Updated PR #${selectedPrNum}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleAssignAgent = async (handle: string) => {
    if (!selectedSlug || selectedPrNum === null || !prDetail) return;
    const current = prDetail.pr.assignedAgents;
    const next = current.includes(handle)
      ? current.filter((h) => h !== handle)
      : [...current, handle];
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedAgents: next }),
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const handlePostReply = async (e: React.FormEvent, parentId: string) => {
    e.preventDefault();
    if (!selectedSlug || selectedPrNum === null || !replyBody.trim()) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/comments`, {
        method: "POST",
        body: JSON.stringify({
          commentType: replyType,
          body: replyBody.trim(),
          parentId,
        }),
      });
      setReplyTargetId(null);
      setReplyBody("");
      await Promise.all([loadPrDetail(), loadRepoData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePostInlineComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug || selectedPrNum === null || !inlineAnchor || !inlineBody.trim()) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/comments`, {
        method: "POST",
        body: JSON.stringify({
          commentType: inlineType,
          body: inlineBody.trim(),
          filePath: inlineAnchor.filePath,
          line: inlineAnchor.line,
        }),
      });
      setInlineAnchor(null);
      setInlineBody("");
      await Promise.all([loadPrDetail(), loadRepoData()]);
      flashNotice(`Posted inline [${inlineType}] comment on ${inlineAnchor.filePath}:${inlineAnchor.line}.`);
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
        body: JSON.stringify({ mergeMethod }),
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
      flashNotice(`Merged PR #${selectedPrNum} (${mergeMethod}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCloseOrReopen = async (action: "close" | "reopen") => {
    if (!selectedSlug || selectedPrNum === null) return;
    setError(null);
    try {
      await apiFetch(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/${action}`, {
        method: "POST",
      });
      await Promise.all([loadPrDetail(), loadRepoData()]);
      flashNotice(action === "close" ? `Closed PR #${selectedPrNum}.` : `Reopened PR #${selectedPrNum}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInvokeAgent = async (agentHandle?: string, commentId?: string) => {
    const target = agentHandle || invokeAgentHandle;
    if (!selectedSlug || selectedPrNum === null) return;
    if (!target) {
      setError("No agent bots registered yet. Add an agent bot in Policy & Agents first.");
      return;
    }
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
      flashNotice(`Dispatched agent.invoked webhook to ${target} (${res.deliveries.length} delivery).`);
      await loadRepoData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFixBlockingWithAgent = async () => {
    const target = invokeAgentHandle || agents[0]?.handle;
    if (!selectedSlug || selectedPrNum === null) return;
    if (!target) {
      setError("No agent bots registered yet. Register a coding agent in Policy & Agents first.");
      return;
    }
    setError(null);
    try {
      const res = await apiFetch<{
        nothingToFix: boolean;
        bundle: { blockingComments: unknown[]; errorFindings: unknown[]; failingChecks: unknown[] };
        deliveries: unknown[];
      }>(`/api/repos/${selectedSlug}/prs/${selectedPrNum}/fix-blocking`, {
        method: "POST",
        body: JSON.stringify({ agentHandle: target }),
      });
      if (res.nothingToFix) {
        flashNotice("Nothing blocking to fix on this PR.");
      } else {
        const total =
          res.bundle.blockingComments.length +
          res.bundle.errorFindings.length +
          res.bundle.failingChecks.length;
        flashNotice(
          `Dispatched ${total} blocking item(s) to ${target} (${res.deliveries.length} delivery).`,
        );
      }
      await loadRepoData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyFollowups = async () => {
    if (!selectedSlug || selectedPrNum === null) return;
    try {
      const res = await apiFetch<{ markdown: string }>(
        `/api/repos/${selectedSlug}/prs/${selectedPrNum}/followups`,
      );
      await navigator.clipboard?.writeText(res.markdown);
      flashNotice("Copied deferred follow-ups Markdown checklist to clipboard.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const [orgName] = selectedSlug ? selectedSlug.split("/") : ["agentic-git", ""];

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
                    onChange={(e) =>
                      navigate({ slug: e.target.value, repoTab: "pulls", prNum: null, prTab: "conversation" })
                    }
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
            {me && (
              <button
                type="button"
                className="btn btn-sm"
                title="Toggle 5-second live polling"
                onClick={() => setLiveRefresh((v) => !v)}
              >
                <span
                  className="gh-live-dot"
                  style={{ opacity: liveRefresh ? 1 : 0.25 }}
                />
                <span>{liveRefresh ? "Live" : "Paused"}</span>
              </button>
            )}

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
              onClick={() => navigate({ repoTab: "pulls", prNum: null })}
            >
              <GitPullRequestIcon size={15} />
              <span>Pull requests</span>
              <span className="gh-counter">{prs.length}</span>
            </button>
            <button
              type="button"
              className={`gh-nav-tab ${repoTab === "activity" ? "active" : ""}`}
              onClick={() => navigate({ repoTab: "activity", prNum: null })}
            >
              <PulseIcon size={15} />
              <span>Push audit & Webhooks</span>
              <span className="gh-counter">{pushes.length}</span>
            </button>
            <button
              type="button"
              className={`gh-nav-tab ${repoTab === "settings" ? "active" : ""}`}
              onClick={() => navigate({ repoTab: "settings", prNum: null })}
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
        ) : repoTab === "settings" ? (
          <SettingsPanel
            currentRepo={currentRepo}
            agents={agents}
            webhooks={webhooks}
            apiFetch={apiFetch}
            onRefresh={async () => {
              await loadWorkspace();
              await loadRepoData();
            }}
            onSelectRepo={(slug) => navigate({ slug, repoTab: "pulls", prNum: null })}
            onError={setError}
            onNotice={flashNotice}
          />
        ) : selectedPrNum === null || !prDetail ? (
          /* GitHub Pull Request List View */
          <div className="stack" style={{ gap: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                {(["all", "open", "merged", "closed"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={`btn btn-sm ${prStatusFilter === st ? "btn-accent" : ""}`}
                    onClick={() => setPrStatusFilter(st)}
                  >
                    {st[0].toUpperCase() + st.slice(1)}
                  </button>
                ))}
              </div>
              <div className="row">
                {currentRepo && currentRepo.forgeType !== "local" && (
                  <button type="button" className="btn btn-sm" onClick={handleSyncUpstream}>
                    Sync from {currentRepo.forgeType}
                  </button>
                )}
                {selectedSlug && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setShowNewPr((v) => !v)}
                  >
                    {showNewPr ? "Cancel" : "New pull request"}
                  </button>
                )}
              </div>
            </div>

            {showNewPr && (
              <form className="gh-box" onSubmit={handleCreatePr}>
                <div className="gh-box-header">
                  <span>Open a new pull request in {selectedSlug}</span>
                </div>
                <div style={{ padding: 16 }} className="stack">
                  <div className="gh-form-grid">
                    <div className="gh-field">
                      <label>Title</label>
                      <input
                        className="input"
                        value={newPrTitle}
                        onChange={(e) => setNewPrTitle(e.target.value)}
                        placeholder="feat: add billing retries"
                        required
                      />
                    </div>
                    <div className="gh-field">
                      <label>Source Branch (head)</label>
                      <input
                        className="input mono"
                        value={newPrHead}
                        onChange={(e) => setNewPrHead(e.target.value)}
                        placeholder="feat/billing-retries"
                        required
                      />
                    </div>
                    <div className="gh-field">
                      <label>Target Branch (base)</label>
                      <input
                        className="input mono"
                        value={newPrBase}
                        onChange={(e) => setNewPrBase(e.target.value)}
                        placeholder={currentRepo?.defaultBranch ?? "main"}
                      />
                    </div>
                  </div>
                  <div className="gh-field">
                    <label>Description (Markdown supported)</label>
                    <textarea
                      rows={3}
                      className="textarea"
                      value={newPrBody}
                      onChange={(e) => setNewPrBody(e.target.value)}
                      placeholder="Summarize what changed and why..."
                    />
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <label className="gh-check-row">
                      <input
                        type="checkbox"
                        checked={newPrAutoMerge}
                        onChange={(e) => setNewPrAutoMerge(e.target.checked)}
                      />
                      <span>Enable auto-merge once all gates pass</span>
                    </label>
                    <button type="submit" className="btn btn-primary">
                      Create pull request
                    </button>
                  </div>
                </div>
              </form>
            )}

            <section className="gh-box">
              <div className="gh-box-header">
                <span className="row">
                  <GitPullRequestIcon size={15} />
                  <span>{prs.filter((p) => p.status === "open").length} Open</span>
                  <span className="muted">
                    · {prs.filter((p) => p.status === "merged").length} Merged
                    · {prs.filter((p) => p.status === "closed").length} Closed
                  </span>
                </span>
                <span className="muted">{selectedSlug || "No repository connected"}</span>
              </div>
              {visiblePrs.length === 0 ? (
                <div style={{ padding: 36, textAlign: "center" }} className="muted">
                  {repos.length === 0 ? (
                    <>
                      No repositories connected yet. Open{" "}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => navigate({ repoTab: "settings" })}
                      >
                        Policy & Agents
                      </button>{" "}
                      or run <code>agit init</code> to connect your GitHub repo.
                    </>
                  ) : (
                    <>No matching pull requests. Push a branch and click <strong>New pull request</strong> or run <code>agit pr create --fill</code>.</>
                  )}
                </div>
              ) : (
                visiblePrs.map((p) => (
                  <div
                    key={p.id}
                    className="gh-pr-row"
                    onClick={() => navigate({ prNum: p.number, prTab: "conversation" })}
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
                        {p.status === "merged"
                          ? "Merged"
                          : p.status === "closed"
                            ? "Closed"
                            : p.gate.canMerge
                              ? "Ready"
                              : "Gated"}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        ) : (
          /* GitHub Pull Request Detail View */
          <div>
            <div style={{ marginBottom: 10 }} className="row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => navigate({ prNum: null, prTab: "conversation" })}
              >
                ← All pull requests ({prs.length})
              </button>
            </div>

            {/* PR Title & Status Subtitle */}
            <div className="gh-pr-header">
              {editingPr ? (
                <form onSubmit={handleSavePrEdit} className="stack" style={{ marginBottom: 12 }}>
                  <input
                    className="input"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    required
                  />
                  <textarea
                    rows={3}
                    className="textarea"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                  />
                  <div className="row">
                    <button type="submit" className="btn btn-primary btn-sm">
                      Save changes
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditingPr(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="gh-pr-title-row">
                  <h1 className="gh-pr-title">
                    {prDetail.pr.title}
                    <span className="gh-pr-number tabular">#{prDetail.pr.number}</span>
                  </h1>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setEditTitle(prDetail.pr.title);
                        setEditDesc(prDetail.pr.description);
                        setEditingPr(true);
                      }}
                    >
                      Edit
                    </button>
                    {prDetail.pr.status === "open" && (
                      <>
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
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => handleCloseOrReopen("close")}
                        >
                          Close PR
                        </button>
                      </>
                    )}
                    {prDetail.pr.status === "closed" && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => handleCloseOrReopen("reopen")}
                      >
                        Reopen PR
                      </button>
                    )}
                  </div>
                </div>
              )}

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
                onClick={() => navigate({ prTab: "conversation" })}
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
                onClick={() => navigate({ prTab: "checks" })}
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
                onClick={() => navigate({ prTab: "files" })}
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

            {/* TAB 1: CONVERSATION */}
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
                        {prDetail.pr.description ? (
                          <MarkdownView text={prDetail.pr.description} />
                        ) : (
                          <span className="muted">No description provided.</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Reviews & Threaded Typed Comments */}
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
                            {rv.body && (
                              <div className="gh-comment-body">
                                <MarkdownView text={rv.body} />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    const { root: c, replies } = item.data;
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
                                onClick={() =>
                                  setReplyTargetId((cur) => (cur === c.id ? null : c.id))
                                }
                              >
                                Reply
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={agents.length === 0}
                                title={
                                  agents.length === 0
                                    ? "Register an agent bot in Policy & Agents first"
                                    : `Send comment to ${invokeAgentHandle}`
                                }
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
                          <div className="gh-comment-body">
                            <MarkdownView text={c.body} />
                          </div>
                          {c.commentTypeMeta?.agentInstruction && (
                            <div className="gh-comment-directive">
                              <BotIcon size={14} />
                              <span>
                                <strong>Agent directive:</strong> {c.commentTypeMeta.agentInstruction}
                              </span>
                            </div>
                          )}

                          {(replies.length > 0 || replyTargetId === c.id) && (
                            <div className="gh-thread-replies">
                              {replies.map((rep) => (
                                <div key={rep.id} className="gh-reply-item">
                                  <div className="row" style={{ marginBottom: 4, fontSize: 12 }}>
                                    <strong>{rep.authorHandle}</strong>
                                    {rep.authorType === "agent" && (
                                      <span className="gh-label gh-label-bot">bot</span>
                                    )}
                                    <span
                                      className="gh-label"
                                      style={{
                                        background: rep.commentTypeMeta?.color ?? "#475569",
                                        color: "#ffffff",
                                      }}
                                    >
                                      {rep.commentTypeMeta?.label ?? rep.commentType}
                                    </span>
                                  </div>
                                  <MarkdownView text={rep.body} />
                                </div>
                              ))}
                              {replyTargetId === c.id && (
                                <form onSubmit={(e) => handlePostReply(e, c.id)} className="stack">
                                  <textarea
                                    rows={2}
                                    className="textarea"
                                    value={replyBody}
                                    onChange={(e) => setReplyBody(e.target.value)}
                                    placeholder="Write a threaded reply (Markdown supported)..."
                                  />
                                  <div className="row" style={{ justifyContent: "space-between" }}>
                                    <select
                                      className="select"
                                      value={replyType}
                                      onChange={(e) => setReplyType(e.target.value)}
                                    >
                                      {prDetail.commentTypes.map((ct) => (
                                        <option key={ct.key} value={ct.key}>
                                          {ct.label}
                                        </option>
                                      ))}
                                    </select>
                                    <div className="row">
                                      <button
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() => setReplyTargetId(null)}
                                      >
                                        Cancel
                                      </button>
                                      <button type="submit" className="btn btn-primary btn-sm">
                                        Post reply
                                      </button>
                                    </div>
                                  </div>
                                </form>
                              )}
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
                          {prDetail.gate.approvals.unsatisfiedGroups.length > 0 && (
                            <>
                              {" "}
                              · Needs any-of:{" "}
                              <strong>
                                {prDetail.gate.approvals.unsatisfiedGroups
                                  .map((g) => `[${g.join(" | ")}]`)
                                  .join(", ")}
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
                        <select
                          aria-label="Merge method"
                          className="select"
                          value={mergeMethod}
                          onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
                          disabled={prDetail.pr.status !== "open"}
                        >
                          <option value="squash">Squash and merge</option>
                          <option value="merge">Merge commit</option>
                          <option value="rebase">Rebase and merge</option>
                        </select>
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
                        {prDetail.pr.status === "open" &&
                          (prDetail.gate.comments.unresolvedBlockingIds.length > 0 ||
                            prDetail.gate.comments.unresolvedErrorFindingIds.length > 0 ||
                            prDetail.gate.ci.checks.some((ch) => ch.status === "failed")) && (
                            <button
                              type="button"
                              className="btn btn-accent"
                              disabled={agents.length === 0}
                              onClick={handleFixBlockingWithAgent}
                            >
                              <PlayIcon size={14} />
                              <span>
                                Fix{" "}
                                {prDetail.gate.comments.unresolvedBlockingIds.length +
                                  prDetail.gate.comments.unresolvedErrorFindingIds.length +
                                  prDetail.gate.ci.checks.filter((ch) => ch.status === "failed").length}{" "}
                                blocking item(s) with Agent
                              </span>
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
                        placeholder="Leave structured Markdown feedback for humans or agents..."
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
                    {agents.length === 0 ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        No agent bots registered
                      </div>
                    ) : (
                      agents.map((ag) => {
                        const assigned = prDetail.pr.assignedAgents.includes(ag.handle);
                        const approved = prDetail.gate.approvals.approvedHandles.includes(ag.handle);
                        return (
                          <div className="gh-rail-row" key={ag.id}>
                            <label className="gh-check-row" style={{ gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={assigned}
                                onChange={() => handleToggleAssignAgent(ag.handle)}
                              />
                              <span className="gh-avatar gh-avatar-sm agent">
                                {initials(ag.handle)}
                              </span>
                              <span>{ag.handle}</span>
                            </label>
                            {assigned && (
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
                            )}
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
                        disabled={agents.length === 0}
                      >
                        {agents.length === 0 ? (
                          <option value="">No agents registered</option>
                        ) : (
                          agents.map((a) => (
                            <option key={a.id} value={a.handle}>
                              {a.handle}
                            </option>
                          ))
                        )}
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
                        disabled={agents.length === 0}
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
                            <div>
                              Covered by {hf.coveredByAgent ?? hf.hiddenByRuleName}
                              {hf.approvedAtSha && (
                                <>
                                  {" "}
                                  <span className="gh-label gh-label-pass mono">
                                    verified @ {hf.approvedAtSha.slice(0, 7)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>
                        No files currently hidden for {me.actor.handle}.
                      </div>
                    )}
                  </div>

                  {prDetail.gate.comments.deferredCount > 0 && (
                    <div className="gh-rail-section">
                      <div className="gh-rail-heading">
                        <span>Deferred Follow-ups</span>
                        <span className="gh-counter">{prDetail.gate.comments.deferredCount}</span>
                      </div>
                      <div className="stack" style={{ gap: 6, fontSize: 12 }}>
                        {prDetail.comments
                          .filter((c) => c.commentType === "defer_to_next_pr" && !c.resolved)
                          .map((c) => (
                            <div key={c.id} className="muted">
                              • {c.body}
                            </div>
                          ))}
                        <button type="button" className="btn btn-sm" onClick={handleCopyFollowups}>
                          Copy Follow-up Checklist
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="gh-rail-section">
                    <div className="gh-rail-heading">
                      <span>Upstream Shadow PR</span>
                      <GitBranchIcon size={14} />
                    </div>
                    <div className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                      {prDetail.pr.upstreamPrUrl &&
                      /^https?:\/\//.test(prDetail.pr.upstreamPrUrl) ? (
                        <a
                          href={prDetail.pr.upstreamPrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="gh-link"
                        >
                          {currentRepo?.forgeType ?? "upstream"} #{prDetail.pr.upstreamPrId} ↗
                        </a>
                      ) : prDetail.pr.upstreamPrId ? (
                        `${currentRepo?.forgeType ?? "upstream"} #${prDetail.pr.upstreamPrId}`
                      ) : (
                        "Local only"
                      )}
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
                            <td className="mono">
                              {ch.url && /^https?:\/\//.test(ch.url) ? (
                                <a href={ch.url} target="_blank" rel="noreferrer" className="gh-link">
                                  {ch.name} ↗
                                </a>
                              ) : (
                                ch.name
                              )}
                            </td>
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

            {/* TAB 3: FILES CHANGED (Inline Click-to-Comment + Agent Filter) */}
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
                      Viewing as <strong>{diffData.viewerHandle}</strong> ({diffData.viewerType}) ·
                      Hover any line and click <code>+</code> to comment inline
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
                                  const targetLine = row.newLine ?? row.oldLine;
                                  const isAnchoredHere =
                                    inlineAnchor !== null &&
                                    inlineAnchor.filePath === f.path &&
                                    inlineAnchor.line === targetLine &&
                                    row.kind !== "hunk";
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
                                          {row.kind !== "hunk" && targetLine !== null && (
                                            <button
                                              type="button"
                                              className="gh-diff-add-btn"
                                              aria-label={`Add inline comment at ${f.path}:${targetLine}`}
                                              title={`Comment on line ${targetLine}`}
                                              onClick={() =>
                                                setInlineAnchor({
                                                  filePath: f.path,
                                                  line: targetLine,
                                                })
                                              }
                                            >
                                              +
                                            </button>
                                          )}
                                          {row.prefix}
                                          {row.content}
                                        </td>
                                      </tr>
                                      {isAnchoredHere && (
                                        <tr className="gh-inline-comment-row">
                                          <td colSpan={3}>
                                            <form onSubmit={handlePostInlineComment} className="stack">
                                              <div className="row" style={{ justifyContent: "space-between" }}>
                                                <div className="row">
                                                  <strong style={{ fontSize: 12 }}>
                                                    Comment on {f.path}:{targetLine}
                                                  </strong>
                                                  {prDetail.commentTypes.slice(0, 4).map((ct) => (
                                                    <button
                                                      key={ct.key}
                                                      type="button"
                                                      className="btn btn-sm"
                                                      style={
                                                        inlineType === ct.key
                                                          ? {
                                                              background: ct.color,
                                                              color: "#ffffff",
                                                              borderColor: ct.color,
                                                            }
                                                          : undefined
                                                      }
                                                      onClick={() => setInlineType(ct.key)}
                                                    >
                                                      {ct.label}
                                                    </button>
                                                  ))}
                                                </div>
                                                <select
                                                  className="select"
                                                  value={inlineType}
                                                  onChange={(e) => setInlineType(e.target.value)}
                                                >
                                                  {prDetail.commentTypes.map((ct) => (
                                                    <option key={ct.key} value={ct.key}>
                                                      {ct.label}
                                                    </option>
                                                  ))}
                                                </select>
                                              </div>
                                              <textarea
                                                rows={2}
                                                className="textarea"
                                                value={inlineBody}
                                                onChange={(e) => setInlineBody(e.target.value)}
                                                placeholder="Write inline review comment..."
                                                autoFocus
                                              />
                                              <div className="row" style={{ justifyContent: "flex-end" }}>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm"
                                                  onClick={() => setInlineAnchor(null)}
                                                >
                                                  Cancel
                                                </button>
                                                <button type="submit" className="btn btn-primary btn-sm">
                                                  Add inline comment
                                                </button>
                                              </div>
                                            </form>
                                          </td>
                                        </tr>
                                      )}
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
                                            <MarkdownView text={lc.body} />
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
