import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CiCheckSchema,
  CommentTypeDefinitionSchema,
  CreateActorInputSchema,
  CreateCommentInputSchema,
  CreatePrInputSchema,
  CreateRepoInputSchema,
  CreateReviewInputSchema,
  CreateWebhookInputSchema,
  DiffFilterRuleSchema,
  InvokeAgentInputSchema,
  MergeMethodSchema,
  MergePolicySchema,
  type CiCheck,
  type MergeMethod,
  type PullRequest,
} from "@agentic-git/shared";
import { z } from "zod";
import {
  checkBranchPushPermission,
  extractTokenFromHeaders,
  resolveUpstreamToken,
} from "./auth.js";
import { Store, type ActorRowInternal, type RepoRowInternal } from "./db.js";
import { ForgeRegistry, MergeConflictError } from "./forges/index.js";
import {
  buildReceivePackRejectResponse,
  buildUpstreamGitAuthHeader,
  parseReceivePack,
  parseReceivePackResult,
} from "./git-protocol.js";
import { evaluateMergeGate, filterDiffFiles } from "./policy-engine.js";
import {
  parseGitHubCiWebhook,
  parseGitLabCiWebhook,
  verifyGitHubWebhookSignature,
  verifyGitLabWebhookToken,
  WebhookDispatcher,
} from "./webhooks.js";

export interface CreateAppOptions {
  store?: Store;
  dbPath?: string;
  forges?: ForgeRegistry;
  fetchImpl?: typeof fetch;
  bootstrapAdminToken?: string;
  webDistDir?: string;
}

export interface AgenticGitContext {
  app: Hono<{ Variables: { actor: ActorRowInternal } }>;
  store: Store;
  forges: ForgeRegistry;
  webhooks: WebhookDispatcher;
  adminToken: string;
}

export function createApp(options: CreateAppOptions = {}): AgenticGitContext {
  const store = options.store ?? new Store(options.dbPath ?? ":memory:");
  const forges = options.forges ?? new ForgeRegistry();
  const fetchImpl = options.fetchImpl ?? fetch;
  const webhooks = new WebhookDispatcher(store, fetchImpl);

  // Ensure an initial admin actor exists so the instance is immediately usable
  let adminToken = options.bootstrapAdminToken ?? "";
  if (store.listActors().length === 0) {
    const created = store.createActor({
      handle: "admin",
      displayName: "System Admin",
      type: "human",
      role: "admin",
      allowedBranchPatterns: ["**"],
      canMerge: true,
      canApprove: true,
      rawToken: options.bootstrapAdminToken,
    });
    adminToken = created.token;
  }

  const app = new Hono<{ Variables: { actor: ActorRowInternal } }>();
  app.use("*", cors());

  // ---- Helper: merge & auto-merge execution ----

  async function executeMerge(
    repo: RepoRowInternal,
    pr: PullRequest,
    actor: ActorRowInternal,
    force = false,
    mergeMethod?: MergeMethod,
  ): Promise<{ pr: PullRequest; mergedSha: string; autoMerged: boolean }> {
    const comments = store.listComments(pr.id, repo);
    const reviews = store.listReviews(pr.id);
    const commentTypes = store.getAllCommentTypes(repo);
    const gate = evaluateMergeGate({
      pr,
      policy: repo.mergePolicy,
      reviews,
      comments,
      commentTypes,
    });

    if (!force && !gate.canMerge) {
      throw Object.assign(new Error(`Merge gate blocked: ${gate.reasons.join("; ")}`), {
        statusCode: 409,
        gate,
      });
    }

    const upstreamToken = resolveUpstreamToken(store, repo, actor);
    const adapter = forges.get(repo.forgeType);
    const { mergedSha } = await adapter.mergePr(repo, upstreamToken, {
      upstreamPrId: pr.upstreamPrId,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      commitTitle: `${pr.title} (#${pr.number})`,
      mergeMethod: mergeMethod ?? repo.mergePolicy.mergeMethod,
    });

    const updated = store.markPrMerged(pr.id, actor.id);
    await webhooks.emit(repo.id, "pr.merged", {
      repo: store.stripRepoInternal(repo),
      pr: updated,
      mergedSha,
      mergedBy: store.stripActorInternal(actor),
    });

    return { pr: updated, mergedSha, autoMerged: false };
  }

  function isMergeCapable(actor: ActorRowInternal | null): boolean {
    return Boolean(actor && (actor.canMerge || actor.role === "admin" || actor.role === "maintainer"));
  }

  function resolveAutoMergeActor(pr: PullRequest): ActorRowInternal {
    const author = store.getActorById(pr.authorActorId);
    if (author && isMergeCapable(author)) return author;
    if (author?.ownerId) {
      const owner = store.getActorById(author.ownerId);
      if (owner && isMergeCapable(owner)) return owner;
    }
    return store.getActorByHandle("admin")!;
  }

  async function maybeAutoMerge(
    repo: RepoRowInternal,
    prId: string,
    triggerActor: ActorRowInternal,
  ): Promise<{ autoMerged: boolean; pr: PullRequest; mergedSha?: string; mergeError?: string }> {
    const pr = store.getPrById(prId);
    if (!pr || pr.status !== "open" || !pr.autoMerge) {
      return { autoMerged: false, pr: pr! };
    }
    const comments = store.listComments(pr.id, repo);
    const reviews = store.listReviews(pr.id);
    const commentTypes = store.getAllCommentTypes(repo);
    const gate = evaluateMergeGate({
      pr,
      policy: repo.mergePolicy,
      reviews,
      comments,
      commentTypes,
    });
    if (!gate.canMerge) {
      return { autoMerged: false, pr };
    }

    try {
      const result = await executeMerge(repo, pr, triggerActor, false);
      return { autoMerged: true, pr: result.pr, mergedSha: result.mergedSha };
    } catch (err) {
      return {
        autoMerged: false,
        pr,
        mergeError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function mergeChecks(existing: CiCheck[], incoming: CiCheck[]): CiCheck[] {
    const byName = new Map<string, CiCheck>();
    for (const c of existing) byName.set(c.name, c);
    for (const c of incoming) byName.set(c.name, c);
    return [...byName.values()];
  }

  // ---- Git Smart-HTTP Proxy (/git/:org/:repo/*) ----

  app.all("/git/:org/:repo/*", async (c) => {
    const token = extractTokenFromHeaders(c.req.raw.headers);
    if (!token) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="agentic-git"' },
      });
    }
    const actor = store.getActorByToken(token);
    if (!actor) {
      return new Response("Invalid agentic-git token", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="agentic-git"' },
      });
    }

    const org = c.req.param("org");
    const repoParam = c.req.param("repo");
    const slug = `${org}/${repoParam.replace(/\.git$/, "")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) {
      return new Response(`Repository '${slug}' not found in agentic-git`, { status: 404 });
    }

    const reqUrl = new URL(c.req.url);
    const prefix = `/git/${org}/${repoParam}/`;
    const subpath = reqUrl.pathname.startsWith(prefix)
      ? reqUrl.pathname.slice(prefix.length)
      : "";
    const upstreamBase = repo.upstreamGitUrl.replace(/\/+$/, "");
    const targetUrl = `${upstreamBase}/${subpath}${reqUrl.search}`;

    const upstreamToken = resolveUpstreamToken(store, repo, actor);
    const upstreamAuth = buildUpstreamGitAuthHeader(repo.forgeType, upstreamToken);

    const isReceivePack = subpath === "git-receive-pack" && c.req.method === "POST";
    let bodyBytes: Uint8Array | undefined;
    let parsedCommands: Array<{ oldSha: string; newSha: string; ref: string }> = [];

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      bodyBytes = new Uint8Array(await c.req.arrayBuffer());
    }

    if (isReceivePack && bodyBytes) {
      const parsed = parseReceivePack(bodyBytes, c.req.header("content-encoding"));
      parsedCommands = parsed.commands;

      let deniedReason: string | null = null;
      for (const cmd of parsedCommands) {
        const decision = checkBranchPushPermission(repo, actor, cmd.ref, cmd.newSha);
        store.recordPushAudit({
          repoId: repo.id,
          actorId: actor.id,
          ref: cmd.ref,
          oldSha: cmd.oldSha,
          newSha: cmd.newSha,
          allowed: decision.allowed,
          reason: decision.reason,
        });
        if (!decision.allowed && !deniedReason) {
          deniedReason = decision.reason;
        }
      }

      if (deniedReason) {
        const rejectBody = buildReceivePackRejectResponse(
          parsedCommands,
          deniedReason,
          parsed.capabilities,
        );
        return new Response(new Uint8Array(rejectBody), {
          status: 200,
          headers: {
            "Content-Type": "application/x-git-receive-pack-result",
            "Cache-Control": "no-cache",
          },
        });
      }
    }

    const forwardHeaders = new Headers();
    const copyHeaderNames = ["content-type", "content-encoding", "accept", "git-protocol", "user-agent"];
    for (const name of copyHeaderNames) {
      const val = c.req.header(name);
      if (val) forwardHeaders.set(name, val);
    }
    if (upstreamAuth) {
      forwardHeaders.set("authorization", upstreamAuth);
    }

    const upstreamRes = await fetchImpl(targetUrl, {
      method: c.req.method,
      headers: forwardHeaders,
      body: bodyBytes ? Buffer.from(bodyBytes) : undefined,
    });

    const resBody = await upstreamRes.arrayBuffer();

    // Post-push hook: sync open PR headShas & notify external agentic apps ONLY for refs upstream accepted
    if (isReceivePack && upstreamRes.ok && parsedCommands.length > 0) {
      const pushResult = parseReceivePackResult(new Uint8Array(resBody));
      if (pushResult.unpackOk) {
        const owner = actor.ownerId ? store.getActorById(actor.ownerId) : null;
        for (const cmd of parsedCommands) {
          if (!cmd.ref.startsWith("refs/heads/") || /^0+$/.test(cmd.newSha)) continue;
          const refOutcome = pushResult.refs.get(cmd.ref);
          if (refOutcome && !refOutcome.ok) continue;
          // If upstream sent explicit report-status lines and didn't confirm this ref as ok, skip
          if (pushResult.refs.size > 0 && !refOutcome?.ok) continue;
          const branch = cmd.ref.slice("refs/heads/".length);
          const openPrs = store.findOpenPrsBySourceBranch(repo.id, branch);
          for (const openPr of openPrs) {
            const updatedPr = store.updatePrHeadSha(openPr.id, cmd.newSha);
            await webhooks.emit(repo.id, "pr.updated", {
              repo: store.stripRepoInternal(repo),
              pr: updatedPr,
              push: {
                ref: cmd.ref,
                oldSha: cmd.oldSha,
                newSha: cmd.newSha,
                actor: store.stripActorInternal(actor),
                ownerHandle: owner?.handle ?? null,
              },
            });
          }
        }
      }
    }

    const outHeaders = new Headers();
    const ct = upstreamRes.headers.get("content-type");
    if (ct) outHeaders.set("content-type", ct);
    const cacheCtrl = upstreamRes.headers.get("cache-control");
    if (cacheCtrl) outHeaders.set("cache-control", cacheCtrl);

    return new Response(resBody, {
      status: upstreamRes.status,
      headers: outHeaders,
    });
  });

  // ---- Public Health & Incoming Upstream Webhooks ----

  app.get("/api/health", (c) => c.json({ ok: true, service: "agentic-git" }));

  app.post("/api/incoming-webhooks/github", async (c) => {
    const eventName = c.req.header("x-github-event") ?? "";
    const sigHeader = c.req.header("x-hub-signature-256") ?? "";
    const rawBody = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const parsed = parseGitHubCiWebhook(eventName, body);
    const repoObj = body.repository as { full_name?: string } | undefined;
    const upstreamRepoName = parsed?.upstreamRepo ?? repoObj?.full_name ?? "";
    const matchedRepos = store
      .listRepos()
      .map((r) => store.getRepoById(r.id)!)
      .filter((r) => r.forgeType === "github" && r.upstreamRepo === upstreamRepoName);

    const envSecret = process.env.AGIT_INCOMING_WEBHOOK_SECRET ?? "";
    if (matchedRepos.length === 0) {
      if (!envSecret || !verifyGitHubWebhookSignature(envSecret, rawBody, sigHeader)) {
        return c.json({ error: "Invalid or missing GitHub webhook signature" }, 401);
      }
      return c.json({ ok: true, ignored: true });
    }

    for (const repo of matchedRepos) {
      const secret = repo.incomingWebhookSecret || envSecret;
      if (!verifyGitHubWebhookSignature(secret, rawBody, sigHeader)) {
        return c.json({ error: "Invalid or missing GitHub webhook signature" }, 401);
      }
    }

    if (!parsed) return c.json({ ok: true, ignored: true });

    const updatedPrs: PullRequest[] = [];
    for (const repo of matchedRepos) {
      const prs = store.findOpenPrsByHeadSha(repo.id, parsed.sha);
      for (const pr of prs) {
        const mergedChecks = mergeChecks(pr.ciChecks, parsed.checks);
        const updated = store.updatePrCiChecks(pr.id, mergedChecks);
        await webhooks.emit(repo.id, "ci.updated", {
          repo: store.stripRepoInternal(repo),
          pr: updated,
          checks: mergedChecks,
        });
        const mergeActor = resolveAutoMergeActor(pr);
        const auto = await maybeAutoMerge(repo, pr.id, mergeActor);
        updatedPrs.push(auto.pr);
      }
    }
    return c.json({ ok: true, updatedCount: updatedPrs.length });
  });

  app.post("/api/incoming-webhooks/gitlab", async (c) => {
    const tokenHeader = c.req.header("x-gitlab-token") ?? "";
    const rawBody = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const parsed = parseGitLabCiWebhook(body);
    const projectObj = body.project as { path_with_namespace?: string } | undefined;
    const upstreamRepoName = parsed?.upstreamRepo ?? projectObj?.path_with_namespace ?? "";
    const matchedRepos = store
      .listRepos()
      .map((r) => store.getRepoById(r.id)!)
      .filter((r) => r.forgeType === "gitlab" && r.upstreamRepo === upstreamRepoName);

    const envSecret = process.env.AGIT_INCOMING_WEBHOOK_SECRET ?? "";
    if (matchedRepos.length === 0) {
      if (!envSecret || !verifyGitLabWebhookToken(envSecret, tokenHeader)) {
        return c.json({ error: "Invalid or missing GitLab webhook token" }, 401);
      }
      return c.json({ ok: true, ignored: true });
    }

    for (const repo of matchedRepos) {
      const secret = repo.incomingWebhookSecret || envSecret;
      if (!verifyGitLabWebhookToken(secret, tokenHeader)) {
        return c.json({ error: "Invalid or missing GitLab webhook token" }, 401);
      }
    }

    if (!parsed) return c.json({ ok: true, ignored: true });

    const updatedPrs: PullRequest[] = [];
    for (const repo of matchedRepos) {
      const prs = store.findOpenPrsByHeadSha(repo.id, parsed.sha);
      for (const pr of prs) {
        const mergedChecks = mergeChecks(pr.ciChecks, parsed.checks);
        const updated = store.updatePrCiChecks(pr.id, mergedChecks);
        await webhooks.emit(repo.id, "ci.updated", {
          repo: store.stripRepoInternal(repo),
          pr: updated,
          checks: mergedChecks,
        });
        const mergeActor = resolveAutoMergeActor(pr);
        const auto = await maybeAutoMerge(repo, pr.id, mergeActor);
        updatedPrs.push(auto.pr);
      }
    }
    return c.json({ ok: true, updatedCount: updatedPrs.length });
  });

  // ---- Authenticated API Routes ----

  app.use("/api/*", async (c, next) => {
    if (
      c.req.path === "/api/health" ||
      c.req.path.startsWith("/api/incoming-webhooks/")
    ) {
      return next();
    }
    const token = extractTokenFromHeaders(c.req.raw.headers);
    if (!token) {
      return c.json({ error: "Missing Authorization token" }, 401);
    }
    const actor = store.getActorByToken(token);
    if (!actor) {
      return c.json({ error: "Invalid Authorization token" }, 401);
    }
    c.set("actor", actor);
    return next();
  });

  app.get("/api/me", (c) => {
    const actor = c.get("actor");
    const owner = actor.ownerId ? store.getActorById(actor.ownerId) : null;
    return c.json({
      actor: store.stripActorInternal(actor),
      owner: owner ? store.stripActorInternal(owner) : null,
      hasUpstreamToken: Boolean(actor.upstreamToken),
    });
  });

  // ---- Actors & Agent Bot Tokens ----

  app.get("/api/actors", (c) => {
    const type = c.req.query("type") as "human" | "agent" | undefined;
    const ownerId = c.req.query("ownerId");
    return c.json({ actors: store.listActors({ type, ownerId }) });
  });

  app.post("/api/actors", async (c) => {
    const caller = c.get("actor");
    const parsed = CreateActorInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid actor payload", details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;

    // Humans can create their own agent bots; creating other humans requires admin
    if (data.type === "human" && caller.role !== "admin") {
      return c.json({ error: "Only admins can create human user accounts" }, 403);
    }
    if (caller.type === "agent" && caller.role !== "admin") {
      return c.json({ error: "Agents cannot create new actors" }, 403);
    }

    const ownerId = data.type === "agent" ? (data.ownerId ?? caller.id) : null;
    try {
      const created = store.createActor({
        handle: data.handle,
        displayName: data.displayName,
        type: data.type,
        role: data.type === "agent" ? (data.role === "admin" ? "agent" : data.role) : data.role,
        ownerId,
        allowedBranchPatterns: data.allowedBranchPatterns,
        canMerge: data.canMerge,
        canApprove: data.canApprove,
        agentWebhookUrl: data.agentWebhookUrl,
        upstreamToken: data.upstreamToken,
      });
      return c.json(created, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.patch("/api/actors/:id/upstream-token", async (c) => {
    const caller = c.get("actor");
    const targetId = c.req.param("id");
    if (caller.id !== targetId && caller.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const body = z.object({ upstreamToken: z.string().nullable() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Invalid body" }, 400);
    store.updateActorUpstreamToken(targetId, body.data.upstreamToken);
    return c.json({ ok: true });
  });

  // ---- Repositories ----

  app.get("/api/repos", (c) => {
    return c.json({ repos: store.listRepos() });
  });

  app.post("/api/repos", async (c) => {
    const caller = c.get("actor");
    if (caller.type === "agent") {
      return c.json({ error: "Agents cannot register new repositories" }, 403);
    }
    const parsed = CreateRepoInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid repo payload", details: parsed.error.flatten() }, 400);
    }
    try {
      const repo = store.createRepo(parsed.data);
      return c.json({ repo }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.get("/api/repos/:org/:repo", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    return c.json({
      repo: store.stripRepoInternal(repo),
      commentTypes: store.getAllCommentTypes(repo),
    });
  });

  app.patch("/api/repos/:org/:repo", async (c) => {
    const caller = c.get("actor");
    if (caller.type === "agent") {
      return c.json({ error: "Agents cannot modify repository policies" }, 403);
    }
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);

    const PatchSchema = z.object({
      protectedBranches: z.array(z.string()).optional(),
      mergePolicy: MergePolicySchema.partial().optional(),
      diffFilterRules: z.array(DiffFilterRuleSchema).optional(),
      customCommentTypes: z.array(CommentTypeDefinitionSchema).optional(),
      credentialMode: z.enum(["service", "per_user"]).optional(),
      upstreamToken: z.string().optional(),
      incomingWebhookSecret: z.string().optional(),
    });
    const parsed = PatchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid repo patch", details: parsed.error.flatten() }, 400);
    }

    const updated = store.updateRepoConfig(repo.id, {
      protectedBranches: parsed.data.protectedBranches,
      mergePolicy: parsed.data.mergePolicy
        ? { ...repo.mergePolicy, ...parsed.data.mergePolicy }
        : undefined,
      diffFilterRules: parsed.data.diffFilterRules,
      customCommentTypes: parsed.data.customCommentTypes,
      credentialMode: parsed.data.credentialMode,
      upstreamToken: parsed.data.upstreamToken,
      incomingWebhookSecret: parsed.data.incomingWebhookSecret,
    });
    return c.json({
      repo: updated,
      commentTypes: store.getAllCommentTypes(updated),
    });
  });

  app.get("/api/repos/:org/:repo/pushes", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    return c.json({ pushes: store.listPushAudit(repo.id) });
  });

  // ---- Webhooks Management ----

  app.get("/api/repos/:org/:repo/webhooks", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    return c.json({ webhooks: store.listWebhookSubscriptions(repo.id) });
  });

  app.post("/api/repos/:org/:repo/webhooks", async (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const parsed = CreateWebhookInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid webhook payload", details: parsed.error.flatten() }, 400);
    }
    const sub = store.createWebhookSubscription({
      repoId: repo.id,
      ...parsed.data,
    });
    return c.json({ webhook: sub }, 201);
  });

  app.get("/api/webhooks/deliveries", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10) || 50;
    return c.json({ deliveries: store.listWebhookDeliveries(limit) });
  });

  // ---- Pull Requests ----

  app.get("/api/repos/:org/:repo/prs", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const status = c.req.query("status") as PullRequest["status"] | undefined;
    const prs = store.listPrs(repo.id, status);
    const commentTypes = store.getAllCommentTypes(repo);
    const enriched = prs.map((pr) => ({
      ...pr,
      gate: evaluateMergeGate({
        pr,
        policy: repo.mergePolicy,
        reviews: store.listReviews(pr.id),
        comments: store.listComments(pr.id, repo),
        commentTypes,
      }),
    }));
    return c.json({ prs: enriched });
  });

  app.post("/api/repos/:org/:repo/prs", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);

    const parsed = CreatePrInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid PR payload", details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;
    const targetBranch = data.targetBranch ?? repo.defaultBranch;

    const existingOpen = store
      .findOpenPrsBySourceBranch(repo.id, data.sourceBranch)
      .find((p) => p.targetBranch === targetBranch);
    if (existingOpen) {
      return c.json(
        {
          error: `An open pull request (#${existingOpen.number}) already exists for '${data.sourceBranch}' -> '${targetBranch}'`,
          existingPr: existingOpen,
        },
        409,
      );
    }

    const upstreamToken = resolveUpstreamToken(store, repo, caller);
    const adapter = forges.get(repo.forgeType);

    let headSha = data.headSha;
    if (!headSha) {
      const resolved = await adapter.getBranchHeadSha(repo, upstreamToken, data.sourceBranch);
      if (!resolved) {
        return c.json(
          { error: `Source branch '${data.sourceBranch}' not found upstream. Push it first.` },
          400,
        );
      }
      headSha = resolved;
    }

    const shadow = await adapter.createShadowPr(repo, upstreamToken, {
      title: data.title,
      description: data.description,
      sourceBranch: data.sourceBranch,
      targetBranch,
    });

    const pr = store.createPr({
      repoId: repo.id,
      title: data.title,
      description: data.description,
      sourceBranch: data.sourceBranch,
      targetBranch,
      headSha: shadow.headSha ?? headSha,
      authorActorId: caller.id,
      upstreamPrId: shadow.upstreamPrId,
      upstreamPrUrl: shadow.upstreamPrUrl,
      autoMerge: data.autoMerge ?? repo.mergePolicy.defaultAutoMerge,
      assignedAgents: data.assignedAgents ?? [],
    });

    await webhooks.emit(repo.id, "pr.opened", {
      repo: store.stripRepoInternal(repo),
      pr,
    });

    return c.json({ pr }, 201);
  });

  app.get("/api/repos/:org/:repo/prs/:number", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const comments = store.listComments(pr.id, repo);
    const reviews = store.listReviews(pr.id);
    const commentTypes = store.getAllCommentTypes(repo);
    const gate = evaluateMergeGate({
      pr,
      policy: repo.mergePolicy,
      reviews,
      comments,
      commentTypes,
    });

    return c.json({ pr, comments, reviews, commentTypes, gate });
  });

  app.patch("/api/repos/:org/:repo/prs/:number", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const PatchPrSchema = z.object({
      autoMerge: z.boolean().optional(),
      assignedAgents: z.array(z.string()).optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
    });
    const parsed = PatchPrSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid PR patch" }, 400);

    const updated = store.updatePrSettings(pr.id, parsed.data);
    const auto = await maybeAutoMerge(repo, updated.id, caller);
    return c.json({ pr: auto.pr, autoMerged: auto.autoMerged, mergedSha: auto.mergedSha });
  });

  app.post("/api/repos/:org/:repo/prs/:number/close", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    if (pr.status === "merged") {
      return c.json({ error: `PR #${num} is already merged and cannot be closed` }, 409);
    }
    if (pr.status === "closed") {
      return c.json({ pr });
    }

    if (pr.upstreamPrId) {
      const upstreamToken = resolveUpstreamToken(store, repo, caller);
      const adapter = forges.get(repo.forgeType);
      await adapter.closeShadowPr(repo, upstreamToken, pr.upstreamPrId);
    }

    const closed = store.markPrClosed(pr.id);
    await webhooks.emit(repo.id, "pr.closed", {
      repo: store.stripRepoInternal(repo),
      pr: closed,
      closedBy: store.stripActorInternal(caller),
    });

    return c.json({ pr: closed });
  });

  // ---- Agent-Aware Filtered Diff ----

  app.get("/api/repos/:org/:repo/prs/:number/diff", async (c) => {
    const viewer = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const includeHidden = c.req.query("includeHidden") === "true";
    const upstreamToken = resolveUpstreamToken(store, repo, viewer);
    const adapter = forges.get(repo.forgeType);
    const targetSha = await adapter.getBranchHeadSha(repo, upstreamToken, pr.targetBranch).catch(() => null);
    const cacheKey = `${pr.targetBranch}@${targetSha ?? "tip"}:${pr.headSha}`;
    let files = store.getCachedDiff(repo.id, cacheKey);
    if (!files) {
      files = await adapter.getPrDiff(repo, upstreamToken, {
        upstreamPrId: pr.upstreamPrId,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      store.setCachedDiff(repo.id, cacheKey, files);
    }

    const reviews = store.listReviews(pr.id);
    const filtered = filterDiffFiles({
      pr,
      files,
      rules: repo.diffFilterRules,
      viewer,
      reviews,
      includeHidden,
    });
    return c.json(filtered);
  });

  // ---- Typed Comments ----

  app.get("/api/repos/:org/:repo/prs/:number/comments", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    let comments = store.listComments(pr.id, repo);
    const typeFilter = c.req.query("type");
    if (typeFilter) comments = comments.filter((cm) => cm.commentType === typeFilter);
    if (c.req.query("unresolved") === "true") comments = comments.filter((cm) => !cm.resolved);
    return c.json({ comments, commentTypes: store.getAllCommentTypes(repo) });
  });

  app.post("/api/repos/:org/:repo/prs/:number/comments", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const parsed = CreateCommentInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid comment payload", details: parsed.error.flatten() }, 400);
    }

    const allTypes = store.getAllCommentTypes(repo);
    const typeDef = allTypes.find((t) => t.key === parsed.data.commentType);
    if (!typeDef) {
      return c.json(
        {
          error: `Unknown commentType '${parsed.data.commentType}'. Allowed: ${allTypes.map((t) => t.key).join(", ")}`,
        },
        400,
      );
    }

    const comment = store.createComment({
      prId: pr.id,
      parentId: parsed.data.parentId,
      authorActorId: caller.id,
      commentType: parsed.data.commentType,
      body: parsed.data.body,
      filePath: parsed.data.filePath,
      line: parsed.data.line,
      severity: parsed.data.severity,
      metadata: parsed.data.metadata,
    });
    comment.commentTypeMeta = typeDef;

    await webhooks.emit(repo.id, "comment.created", {
      repo: store.stripRepoInternal(repo),
      pr,
      comment,
      commentTypeDefinition: typeDef,
    });

    return c.json({ comment }, 201);
  });

  app.post("/api/comments/:id/resolve", async (c) => {
    const caller = c.get("actor");
    const comment = store.getCommentById(c.req.param("id"));
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    const pr = store.getPrById(comment.prId)!;
    const repo = store.getRepoById(pr.repoId)!;

    const typeDef = store.getAllCommentTypes(repo).find((t) => t.key === comment.commentType);
    const isBlocking =
      Boolean(typeDef?.blocksMerge) ||
      (repo.mergePolicy.blockOnErrorFindings &&
        comment.commentType === "agent_finding" &&
        comment.severity === "error");

    if (isBlocking) {
      if (caller.type === "agent" && comment.authorType === "human") {
        return c.json(
          {
            error: `Agent '${caller.handle}' cannot resolve a blocking comment authored by human '${comment.authorHandle}'`,
          },
          403,
        );
      }
      if (
        !repo.mergePolicy.allowAuthorResolveBlocking &&
        caller.id === pr.authorActorId &&
        caller.role !== "admin"
      ) {
        return c.json(
          {
            error: `PR author '${caller.handle}' cannot unilaterally resolve blocking comments under repo merge policy`,
          },
          403,
        );
      }
    }

    const updated = store.setCommentResolved(comment.id, true, caller.id);
    await webhooks.emit(repo.id, "comment.resolved", {
      repo: store.stripRepoInternal(repo),
      pr,
      comment: updated,
      resolvedBy: store.stripActorInternal(caller),
    });

    const auto = await maybeAutoMerge(repo, pr.id, caller);
    return c.json({
      comment: updated,
      autoMerged: auto.autoMerged,
      mergedSha: auto.mergedSha,
    });
  });

  app.post("/api/comments/:id/reopen", async (c) => {
    const caller = c.get("actor");
    const comment = store.getCommentById(c.req.param("id"));
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    const pr = store.getPrById(comment.prId)!;
    const repo = store.getRepoById(pr.repoId)!;

    const updated = store.setCommentResolved(comment.id, false, caller.id);
    await webhooks.emit(repo.id, "comment.reopened", {
      repo: store.stripRepoInternal(repo),
      pr,
      comment: updated,
      reopenedBy: store.stripActorInternal(caller),
    });

    return c.json({ comment: updated });
  });

  // ---- Reviews ----

  app.get("/api/repos/:org/:repo/prs/:number/reviews", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);
    return c.json({ reviews: store.listReviews(pr.id) });
  });

  app.post("/api/repos/:org/:repo/prs/:number/reviews", async (c) => {
    const caller = c.get("actor");
    if (!caller.canApprove) {
      return c.json({ error: `Actor '${caller.handle}' does not have approval permissions` }, 403);
    }
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const parsed = CreateReviewInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid review payload" }, 400);

    if (
      parsed.data.status === "approved" &&
      caller.id === pr.authorActorId &&
      !repo.mergePolicy.allowSelfApproval
    ) {
      return c.json(
        { error: `PR author '${caller.handle}' cannot approve their own pull request` },
        403,
      );
    }

    const review = store.createReview({
      prId: pr.id,
      actorId: caller.id,
      status: parsed.data.status,
      body: parsed.data.body,
      commitSha: pr.headSha,
    });

    await webhooks.emit(repo.id, "review.submitted", {
      repo: store.stripRepoInternal(repo),
      pr,
      review,
    });

    const auto = await maybeAutoMerge(repo, pr.id, caller);
    const gate = evaluateMergeGate({
      pr: auto.pr,
      policy: repo.mergePolicy,
      reviews: store.listReviews(pr.id),
      comments: store.listComments(pr.id, repo),
      commentTypes: store.getAllCommentTypes(repo),
    });

    return c.json(
      {
        review,
        gate,
        autoMerged: auto.autoMerged,
        mergedSha: auto.mergedSha,
        mergeError: auto.mergeError,
      },
      201,
    );
  });

  // ---- Merge Gate, CI Sync & Merge ----

  app.get("/api/repos/:org/:repo/prs/:number/gate", (c) => {
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const gate = evaluateMergeGate({
      pr,
      policy: repo.mergePolicy,
      reviews: store.listReviews(pr.id),
      comments: store.listComments(pr.id, repo),
      commentTypes: store.getAllCommentTypes(repo),
    });
    return c.json({ gate, policy: repo.mergePolicy });
  });

  app.post("/api/repos/:org/:repo/prs/:number/ci", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    let incomingChecks: CiCheck[];
    const rawBody = await c.req.text();
    const parsedBody = rawBody ? (JSON.parse(rawBody) as { checks?: unknown[] }) : {};

    if (Array.isArray(parsedBody.checks)) {
      const checkList = z.array(CiCheckSchema).safeParse(parsedBody.checks);
      if (!checkList.success) {
        return c.json({ error: "Invalid CI checks payload", details: checkList.error.flatten() }, 400);
      }
      incomingChecks = checkList.data;
    } else {
      const upstreamToken = resolveUpstreamToken(store, repo, caller);
      const adapter = forges.get(repo.forgeType);
      incomingChecks = await adapter.getCommitChecks(repo, upstreamToken, pr.headSha);
    }

    const merged = mergeChecks(pr.ciChecks, incomingChecks);
    const updated = store.updatePrCiChecks(pr.id, merged);

    await webhooks.emit(repo.id, "ci.updated", {
      repo: store.stripRepoInternal(repo),
      pr: updated,
      checks: merged,
    });

    const auto = await maybeAutoMerge(repo, pr.id, caller);
    const gate = evaluateMergeGate({
      pr: auto.pr,
      policy: repo.mergePolicy,
      reviews: store.listReviews(pr.id),
      comments: store.listComments(pr.id, repo),
      commentTypes: store.getAllCommentTypes(repo),
    });

    return c.json({
      pr: auto.pr,
      checks: merged,
      gate,
      autoMerged: auto.autoMerged,
      mergedSha: auto.mergedSha,
    });
  });

  app.post("/api/repos/:org/:repo/prs/:number/merge", async (c) => {
    const caller = c.get("actor");
    if (!caller.canMerge && caller.role !== "admin" && caller.role !== "maintainer") {
      return c.json({ error: `Actor '${caller.handle}' does not have merge permission` }, 403);
    }
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const rawBody = await c.req.text();
    const parsedBody = rawBody
      ? z
          .object({
            force: z.boolean().optional(),
            mergeMethod: MergeMethodSchema.optional(),
          })
          .safeParse(JSON.parse(rawBody))
      : { success: true as const, data: {} as { force?: boolean; mergeMethod?: MergeMethod } };
    if (!parsedBody.success) {
      return c.json({ error: "Invalid merge payload" }, 400);
    }
    const force = Boolean(parsedBody.data.force) && caller.role === "admin";

    try {
      const result = await executeMerge(repo, pr, caller, force, parsedBody.data.mergeMethod);
      return c.json({ pr: result.pr, mergedSha: result.mergedSha });
    } catch (err) {
      if (err instanceof MergeConflictError) {
        return c.json(
          { error: err.message, conflictingFiles: err.conflictingFiles },
          409,
        );
      }
      const e = err as Error & { statusCode?: number; gate?: unknown };
      return c.json(
        { error: e.message, gate: e.gate },
        (e.statusCode as 409 | 500) ?? 500,
      );
    }
  });

  // ---- Direct Agent Invocation (UI / CLI -> External Agentic App) ----

  app.post("/api/repos/:org/:repo/prs/:number/invoke-agent", async (c) => {
    const caller = c.get("actor");
    const slug = `${c.req.param("org")}/${c.req.param("repo")}`;
    const repo = store.getRepoBySlug(slug);
    if (!repo) return c.json({ error: `Repo '${slug}' not found` }, 404);
    const num = Number.parseInt(c.req.param("number"), 10);
    const pr = store.getPrByNumber(repo.id, num);
    if (!pr) return c.json({ error: `PR #${num} not found` }, 404);

    const parsed = InvokeAgentInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid invoke payload", details: parsed.error.flatten() }, 400);
    }

    const targetAgent = store.getActorByHandle(parsed.data.agentHandle);
    const comment = parsed.data.commentId ? store.getCommentById(parsed.data.commentId) : null;
    const commentTypeDef = comment
      ? store.getAllCommentTypes(repo).find((t) => t.key === comment.commentType)
      : null;

    const extraTargets: Array<{ id: string; url: string; secret: string }> = [];
    const directUrl = parsed.data.targetUrl ?? targetAgent?.agentWebhookUrl ?? null;
    if (directUrl) {
      extraTargets.push({
        id: `agent-direct:${parsed.data.agentHandle}`,
        url: directUrl,
        secret: "agentic-git-direct",
      });
    }

    const deliveries = await webhooks.emit(
      repo.id,
      "agent.invoked",
      {
        repo: store.stripRepoInternal(repo),
        pr,
        invokedBy: store.stripActorInternal(caller),
        targetAgentHandle: parsed.data.agentHandle,
        prompt: parsed.data.prompt,
        comment: comment ? { ...comment, commentTypeMeta: commentTypeDef ?? undefined } : null,
      },
      extraTargets,
    );

    return c.json({ ok: true, deliveries }, 202);
  });

  // ---- Optional Static Web UI Serving ----
  if (options.webDistDir && fs.existsSync(options.webDistDir)) {
    const distRoot = path.resolve(options.webDistDir);
    const mimeByExt: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
    };

    app.get("*", (c) => {
      const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const safeRel = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
      let filePath = path.join(distRoot, safeRel);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distRoot, "index.html");
      }
      const ext = path.extname(filePath);
      const body = fs.readFileSync(filePath);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "Content-Type": mimeByExt[ext] ?? "application/octet-stream" },
      });
    });
  }

  return { app, store, forges, webhooks, adminToken };
}
