import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import {
  BUILTIN_COMMENT_TYPES,
  DEFAULT_MERGE_POLICY,
  type Actor,
  type CiCheck,
  type CommentTypeDefinition,
  type DiffFile,
  type DiffFilterRule,
  type MergePolicy,
  type PrComment,
  type PrReview,
  type PullRequest,
  type PushAuditEntry,
  type Repo,
  type WebhookDelivery,
  type WebhookEventType,
  type WebhookSubscription,
} from "@agentic-git/shared";

export interface ActorRowInternal extends Actor {
  upstreamToken: string | null;
}

export interface RepoRowInternal extends Repo {
  upstreamToken: string;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(prefix = "agit"): string {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        owner_id TEXT,
        token_hash TEXT UNIQUE NOT NULL,
        upstream_token TEXT,
        allowed_branch_patterns TEXT NOT NULL,
        can_merge INTEGER NOT NULL DEFAULT 0,
        can_approve INTEGER NOT NULL DEFAULT 1,
        agent_webhook_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        forge_type TEXT NOT NULL,
        forge_base_url TEXT NOT NULL,
        upstream_repo TEXT NOT NULL,
        upstream_git_url TEXT NOT NULL,
        upstream_token TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        credential_mode TEXT NOT NULL,
        protected_branches TEXT NOT NULL,
        merge_policy TEXT NOT NULL,
        diff_filter_rules TEXT NOT NULL,
        custom_comment_types TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        author_actor_id TEXT NOT NULL REFERENCES actors(id),
        upstream_pr_id TEXT,
        upstream_pr_url TEXT,
        auto_merge INTEGER NOT NULL DEFAULT 0,
        assigned_agents TEXT NOT NULL,
        ci_checks TEXT NOT NULL,
        merged_at TEXT,
        merged_by_actor_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_id, number)
      );

      CREATE TABLE IF NOT EXISTS pr_comments (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        parent_id TEXT,
        author_actor_id TEXT NOT NULL REFERENCES actors(id),
        comment_type TEXT NOT NULL,
        body TEXT NOT NULL,
        file_path TEXT,
        line INTEGER,
        severity TEXT,
        metadata TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_by_actor_id TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pr_reviews (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES actors(id),
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_audit (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES actors(id),
        ref TEXT NOT NULL,
        old_sha TEXT NOT NULL,
        new_sha TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        event TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        status_code INTEGER,
        response_body TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diff_cache (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, cache_key)
      );
    `);
  }

  // ---- Actors ----

  createActor(input: {
    handle: string;
    displayName: string;
    type: Actor["type"];
    role: Actor["role"];
    ownerId?: string | null;
    allowedBranchPatterns?: string[];
    canMerge?: boolean;
    canApprove?: boolean;
    agentWebhookUrl?: string | null;
    upstreamToken?: string | null;
    rawToken?: string;
  }): { actor: Actor; token: string } {
    const id = newId("act");
    const token = input.rawToken ?? generateToken(input.type === "agent" ? "agit_bot" : "agit_usr");
    const now = new Date().toISOString();
    const patterns = input.allowedBranchPatterns ?? (input.type === "agent" ? ["agent/**", "feature/**"] : ["**"]);
    const canMerge = input.canMerge ?? (input.role === "admin" || input.role === "maintainer");
    const canApprove = input.canApprove ?? true;

    this.db
      .prepare(
        `INSERT INTO actors (id, handle, display_name, type, role, owner_id, token_hash, upstream_token, allowed_branch_patterns, can_merge, can_approve, agent_webhook_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.handle,
        input.displayName,
        input.type,
        input.role,
        input.ownerId ?? null,
        hashToken(token),
        input.upstreamToken ?? null,
        JSON.stringify(patterns),
        canMerge ? 1 : 0,
        canApprove ? 1 : 0,
        input.agentWebhookUrl ?? null,
        now,
      );

    const actor = this.getActorById(id)!;
    return { actor: this.stripActorInternal(actor), token };
  }

  private mapActorRow(row: Record<string, unknown>): ActorRowInternal {
    return {
      id: String(row.id),
      handle: String(row.handle),
      displayName: String(row.display_name),
      type: row.type as Actor["type"],
      role: row.role as Actor["role"],
      ownerId: row.owner_id ? String(row.owner_id) : null,
      allowedBranchPatterns: JSON.parse(String(row.allowed_branch_patterns)),
      canMerge: Boolean(row.can_merge),
      canApprove: Boolean(row.can_approve),
      agentWebhookUrl: row.agent_webhook_url ? String(row.agent_webhook_url) : null,
      upstreamToken: row.upstream_token ? String(row.upstream_token) : null,
      createdAt: String(row.created_at),
    };
  }

  stripActorInternal(actor: ActorRowInternal): Actor {
    const { upstreamToken: _ignored, ...rest } = actor;
    return rest;
  }

  getActorByToken(rawToken: string): ActorRowInternal | null {
    const row = this.db
      .prepare(`SELECT * FROM actors WHERE token_hash = ?`)
      .get(hashToken(rawToken)) as Record<string, unknown> | undefined;
    return row ? this.mapActorRow(row) : null;
  }

  getActorById(id: string): ActorRowInternal | null {
    const row = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapActorRow(row) : null;
  }

  getActorByHandle(handle: string): ActorRowInternal | null {
    const row = this.db.prepare(`SELECT * FROM actors WHERE handle = ?`).get(handle) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapActorRow(row) : null;
  }

  listActors(filter?: { type?: Actor["type"]; ownerId?: string }): Actor[] {
    let sql = `SELECT * FROM actors WHERE 1=1`;
    const params: (string | number)[] = [];
    if (filter?.type) {
      sql += ` AND type = ?`;
      params.push(filter.type);
    }
    if (filter?.ownerId) {
      sql += ` AND owner_id = ?`;
      params.push(filter.ownerId);
    }
    sql += ` ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.stripActorInternal(this.mapActorRow(r)));
  }

  updateActorUpstreamToken(actorId: string, upstreamToken: string | null): void {
    this.db.prepare(`UPDATE actors SET upstream_token = ? WHERE id = ?`).run(upstreamToken, actorId);
  }

  // ---- Repos ----

  createRepo(input: {
    slug: string;
    forgeType: Repo["forgeType"];
    forgeBaseUrl: string;
    upstreamRepo: string;
    upstreamGitUrl: string;
    upstreamToken: string;
    defaultBranch?: string;
    credentialMode?: Repo["credentialMode"];
    protectedBranches?: string[];
    mergePolicy?: Partial<MergePolicy>;
    diffFilterRules?: DiffFilterRule[];
    customCommentTypes?: CommentTypeDefinition[];
  }): Repo {
    const id = newId("rep");
    const now = new Date().toISOString();
    const policy: MergePolicy = { ...DEFAULT_MERGE_POLICY, ...input.mergePolicy };
    this.db
      .prepare(
        `INSERT INTO repos (id, slug, forge_type, forge_base_url, upstream_repo, upstream_git_url, upstream_token, default_branch, credential_mode, protected_branches, merge_policy, diff_filter_rules, custom_comment_types, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.slug,
        input.forgeType,
        input.forgeBaseUrl,
        input.upstreamRepo,
        input.upstreamGitUrl,
        input.upstreamToken,
        input.defaultBranch ?? "main",
        input.credentialMode ?? "service",
        JSON.stringify(input.protectedBranches ?? ["main", "master"]),
        JSON.stringify(policy),
        JSON.stringify(input.diffFilterRules ?? []),
        JSON.stringify(input.customCommentTypes ?? []),
        now,
      );
    return this.stripRepoInternal(this.getRepoById(id)!);
  }

  private mapRepoRow(row: Record<string, unknown>): RepoRowInternal {
    return {
      id: String(row.id),
      slug: String(row.slug),
      forgeType: row.forge_type as Repo["forgeType"],
      forgeBaseUrl: String(row.forge_base_url),
      upstreamRepo: String(row.upstream_repo),
      upstreamGitUrl: String(row.upstream_git_url),
      upstreamToken: String(row.upstream_token),
      defaultBranch: String(row.default_branch),
      credentialMode: row.credential_mode as Repo["credentialMode"],
      protectedBranches: JSON.parse(String(row.protected_branches)),
      mergePolicy: { ...DEFAULT_MERGE_POLICY, ...JSON.parse(String(row.merge_policy)) },
      diffFilterRules: JSON.parse(String(row.diff_filter_rules)),
      customCommentTypes: JSON.parse(String(row.custom_comment_types)),
      createdAt: String(row.created_at),
    };
  }

  stripRepoInternal(repo: RepoRowInternal): Repo {
    const { upstreamToken: _ignored, ...rest } = repo;
    return rest;
  }

  getRepoById(id: string): RepoRowInternal | null {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRepoRow(row) : null;
  }

  getRepoBySlug(slug: string): RepoRowInternal | null {
    const clean = slug.replace(/\.git$/, "");
    const row = this.db.prepare(`SELECT * FROM repos WHERE slug = ?`).get(clean) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRepoRow(row) : null;
  }

  listRepos(): Repo[] {
    const rows = this.db.prepare(`SELECT * FROM repos ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.stripRepoInternal(this.mapRepoRow(r)));
  }

  updateRepoConfig(
    repoId: string,
    patch: {
      protectedBranches?: string[];
      mergePolicy?: MergePolicy;
      diffFilterRules?: DiffFilterRule[];
      customCommentTypes?: CommentTypeDefinition[];
      credentialMode?: Repo["credentialMode"];
      upstreamToken?: string;
    },
  ): Repo {
    const existing = this.getRepoById(repoId);
    if (!existing) throw new Error(`Repo ${repoId} not found`);
    this.db
      .prepare(
        `UPDATE repos
         SET protected_branches = ?, merge_policy = ?, diff_filter_rules = ?, custom_comment_types = ?, credential_mode = ?, upstream_token = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(patch.protectedBranches ?? existing.protectedBranches),
        JSON.stringify(patch.mergePolicy ?? existing.mergePolicy),
        JSON.stringify(patch.diffFilterRules ?? existing.diffFilterRules),
        JSON.stringify(patch.customCommentTypes ?? existing.customCommentTypes),
        patch.credentialMode ?? existing.credentialMode,
        patch.upstreamToken ?? existing.upstreamToken,
        repoId,
      );
    return this.stripRepoInternal(this.getRepoById(repoId)!);
  }

  getAllCommentTypes(repo: Repo): CommentTypeDefinition[] {
    const byKey = new Map<string, CommentTypeDefinition>();
    for (const ct of BUILTIN_COMMENT_TYPES) {
      byKey.set(ct.key, ct);
    }
    for (const ct of repo.customCommentTypes) {
      byKey.set(ct.key, { ...ct, builtin: false });
    }
    return [...byKey.values()];
  }

  // ---- Pull Requests ----

  createPr(input: {
    repoId: string;
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
    headSha: string;
    authorActorId: string;
    upstreamPrId: string | null;
    upstreamPrUrl: string | null;
    autoMerge: boolean;
    assignedAgents: string[];
  }): PullRequest {
    const id = newId("pr");
    const now = new Date().toISOString();
    const maxRow = this.db
      .prepare(`SELECT COALESCE(MAX(number), 0) AS max_num FROM pull_requests WHERE repo_id = ?`)
      .get(input.repoId) as { max_num: number };
    const nextNumber = Number(maxRow.max_num) + 1;

    this.db
      .prepare(
        `INSERT INTO pull_requests (id, number, repo_id, title, description, source_branch, target_branch, head_sha, status, author_actor_id, upstream_pr_id, upstream_pr_url, auto_merge, assigned_agents, ci_checks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        nextNumber,
        input.repoId,
        input.title,
        input.description,
        input.sourceBranch,
        input.targetBranch,
        input.headSha,
        input.authorActorId,
        input.upstreamPrId,
        input.upstreamPrUrl,
        input.autoMerge ? 1 : 0,
        JSON.stringify(input.assignedAgents),
        now,
        now,
      );

    return this.getPrById(id)!;
  }

  private mapPrRow(row: Record<string, unknown>): PullRequest {
    return {
      id: String(row.id),
      number: Number(row.number),
      repoId: String(row.repo_id),
      repoSlug: String(row.repo_slug),
      title: String(row.title),
      description: String(row.description),
      sourceBranch: String(row.source_branch),
      targetBranch: String(row.target_branch),
      headSha: String(row.head_sha),
      status: row.status as PullRequest["status"],
      authorActorId: String(row.author_actor_id),
      authorHandle: String(row.author_handle),
      authorType: row.author_type as PullRequest["authorType"],
      authorOwnerHandle: row.author_owner_handle ? String(row.author_owner_handle) : null,
      upstreamPrId: row.upstream_pr_id ? String(row.upstream_pr_id) : null,
      upstreamPrUrl: row.upstream_pr_url ? String(row.upstream_pr_url) : null,
      autoMerge: Boolean(row.auto_merge),
      assignedAgents: JSON.parse(String(row.assigned_agents)),
      ciChecks: JSON.parse(String(row.ci_checks)),
      mergedAt: row.merged_at ? String(row.merged_at) : null,
      mergedByActorId: row.merged_by_actor_id ? String(row.merged_by_actor_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private prSelectSql(): string {
    return `
      SELECT pr.*,
             r.slug AS repo_slug,
             a.handle AS author_handle,
             a.type AS author_type,
             o.handle AS author_owner_handle
      FROM pull_requests pr
      JOIN repos r ON r.id = pr.repo_id
      JOIN actors a ON a.id = pr.author_actor_id
      LEFT JOIN actors o ON o.id = a.owner_id
    `;
  }

  getPrById(id: string): PullRequest | null {
    const row = this.db.prepare(`${this.prSelectSql()} WHERE pr.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapPrRow(row) : null;
  }

  getPrByNumber(repoId: string, num: number): PullRequest | null {
    const row = this.db
      .prepare(`${this.prSelectSql()} WHERE pr.repo_id = ? AND pr.number = ?`)
      .get(repoId, num) as Record<string, unknown> | undefined;
    return row ? this.mapPrRow(row) : null;
  }

  findOpenPrsBySourceBranch(repoId: string, sourceBranch: string): PullRequest[] {
    const rows = this.db
      .prepare(`${this.prSelectSql()} WHERE pr.repo_id = ? AND pr.source_branch = ? AND pr.status = 'open'`)
      .all(repoId, sourceBranch) as Record<string, unknown>[];
    return rows.map((r) => this.mapPrRow(r));
  }

  findOpenPrsByHeadSha(repoId: string, headSha: string): PullRequest[] {
    const rows = this.db
      .prepare(`${this.prSelectSql()} WHERE pr.repo_id = ? AND pr.head_sha = ? AND pr.status = 'open'`)
      .all(repoId, headSha) as Record<string, unknown>[];
    return rows.map((r) => this.mapPrRow(r));
  }

  listPrs(repoId: string, status?: PullRequest["status"]): PullRequest[] {
    let sql = `${this.prSelectSql()} WHERE pr.repo_id = ?`;
    const params: (string | number)[] = [repoId];
    if (status) {
      sql += ` AND pr.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY pr.number DESC`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapPrRow(r));
  }

  updatePrHeadSha(prId: string, headSha: string): PullRequest {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE pull_requests SET head_sha = ?, updated_at = ? WHERE id = ?`)
      .run(headSha, now, prId);
    return this.getPrById(prId)!;
  }

  updatePrSettings(
    prId: string,
    patch: { autoMerge?: boolean; assignedAgents?: string[]; title?: string; description?: string },
  ): PullRequest {
    const existing = this.getPrById(prId);
    if (!existing) throw new Error(`PR ${prId} not found`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pull_requests SET auto_merge = ?, assigned_agents = ?, title = ?, description = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        (patch.autoMerge ?? existing.autoMerge) ? 1 : 0,
        JSON.stringify(patch.assignedAgents ?? existing.assignedAgents),
        patch.title ?? existing.title,
        patch.description ?? existing.description,
        now,
        prId,
      );
    return this.getPrById(prId)!;
  }

  updatePrCiChecks(prId: string, checks: CiCheck[]): PullRequest {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE pull_requests SET ci_checks = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(checks), now, prId);
    return this.getPrById(prId)!;
  }

  markPrMerged(prId: string, mergedByActorId: string): PullRequest {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pull_requests SET status = 'merged', merged_at = ?, merged_by_actor_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, mergedByActorId, now, prId);
    return this.getPrById(prId)!;
  }

  markPrClosed(prId: string): PullRequest {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE pull_requests SET status = 'closed', updated_at = ? WHERE id = ?`)
      .run(now, prId);
    return this.getPrById(prId)!;
  }

  // ---- Comments ----

  createComment(input: {
    prId: string;
    parentId?: string | null;
    authorActorId: string;
    commentType: string;
    body: string;
    filePath?: string | null;
    line?: number | null;
    severity?: PrComment["severity"];
    metadata?: Record<string, unknown>;
  }): PrComment {
    const id = newId("cmt");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_comments (id, pr_id, parent_id, author_actor_id, comment_type, body, file_path, line, severity, metadata, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.prId,
        input.parentId ?? null,
        input.authorActorId,
        input.commentType,
        input.body,
        input.filePath ?? null,
        input.line ?? null,
        input.severity ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
      );
    return this.getCommentById(id)!;
  }

  private commentSelectSql(): string {
    return `
      SELECT c.*,
             a.handle AS author_handle,
             a.type AS author_type,
             o.handle AS author_owner_handle,
             ra.handle AS resolved_by_handle
      FROM pr_comments c
      JOIN actors a ON a.id = c.author_actor_id
      LEFT JOIN actors o ON o.id = a.owner_id
      LEFT JOIN actors ra ON ra.id = c.resolved_by_actor_id
    `;
  }

  private mapCommentRow(row: Record<string, unknown>): PrComment {
    return {
      id: String(row.id),
      prId: String(row.pr_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      authorActorId: String(row.author_actor_id),
      authorHandle: String(row.author_handle),
      authorType: row.author_type as PrComment["authorType"],
      authorOwnerHandle: row.author_owner_handle ? String(row.author_owner_handle) : null,
      commentType: String(row.comment_type),
      body: String(row.body),
      filePath: row.file_path ? String(row.file_path) : null,
      line: row.line !== null && row.line !== undefined ? Number(row.line) : null,
      severity: (row.severity as PrComment["severity"]) ?? null,
      metadata: JSON.parse(String(row.metadata)),
      resolved: Boolean(row.resolved),
      resolvedByHandle: row.resolved_by_handle ? String(row.resolved_by_handle) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      createdAt: String(row.created_at),
    };
  }

  getCommentById(id: string): PrComment | null {
    const row = this.db.prepare(`${this.commentSelectSql()} WHERE c.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapCommentRow(row) : null;
  }

  listComments(prId: string, repo?: Repo): PrComment[] {
    const rows = this.db
      .prepare(`${this.commentSelectSql()} WHERE c.pr_id = ? ORDER BY c.created_at ASC`)
      .all(prId) as Record<string, unknown>[];
    const typeMap = repo
      ? new Map(this.getAllCommentTypes(repo).map((ct) => [ct.key, ct]))
      : new Map(BUILTIN_COMMENT_TYPES.map((ct) => [ct.key, ct]));
    return rows.map((r) => {
      const c = this.mapCommentRow(r);
      c.commentTypeMeta = typeMap.get(c.commentType);
      return c;
    });
  }

  setCommentResolved(commentId: string, resolved: boolean, actorId: string): PrComment {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pr_comments SET resolved = ?, resolved_by_actor_id = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(resolved ? 1 : 0, resolved ? actorId : null, resolved ? now : null, commentId);
    return this.getCommentById(commentId)!;
  }

  // ---- Reviews ----

  createReview(input: {
    prId: string;
    actorId: string;
    status: PrReview["status"];
    body: string;
    commitSha: string;
  }): PrReview {
    const id = newId("rev");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_reviews (id, pr_id, actor_id, status, body, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.prId, input.actorId, input.status, input.body, input.commitSha, now);
    return this.listReviews(input.prId).find((r) => r.id === id)!;
  }

  listReviews(prId: string): PrReview[] {
    const rows = this.db
      .prepare(
        `SELECT rv.*, a.handle AS actor_handle, a.type AS actor_type, o.handle AS actor_owner_handle
         FROM pr_reviews rv
         JOIN actors a ON a.id = rv.actor_id
         LEFT JOIN actors o ON o.id = a.owner_id
         WHERE rv.pr_id = ?
         ORDER BY rv.created_at ASC`,
      )
      .all(prId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      prId: String(row.pr_id),
      actorId: String(row.actor_id),
      actorHandle: String(row.actor_handle),
      actorType: row.actor_type as PrReview["actorType"],
      actorOwnerHandle: row.actor_owner_handle ? String(row.actor_owner_handle) : null,
      status: row.status as PrReview["status"],
      body: String(row.body),
      commitSha: String(row.commit_sha),
      createdAt: String(row.created_at),
    }));
  }

  // ---- Push Audit ----

  recordPushAudit(input: {
    repoId: string;
    actorId: string;
    ref: string;
    oldSha: string;
    newSha: string;
    allowed: boolean;
    reason: string;
  }): void {
    const id = newId("psh");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO push_audit (id, repo_id, actor_id, ref, old_sha, new_sha, allowed, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.repoId,
        input.actorId,
        input.ref,
        input.oldSha,
        input.newSha,
        input.allowed ? 1 : 0,
        input.reason,
        now,
      );
  }

  listPushAudit(repoId: string, limit = 50): PushAuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, a.handle AS actor_handle, a.type AS actor_type, o.handle AS owner_handle
         FROM push_audit p
         JOIN actors a ON a.id = p.actor_id
         LEFT JOIN actors o ON o.id = a.owner_id
         WHERE p.repo_id = ?
         ORDER BY p.created_at DESC
         LIMIT ?`,
      )
      .all(repoId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      repoId: String(row.repo_id),
      actorId: String(row.actor_id),
      actorHandle: String(row.actor_handle),
      actorType: row.actor_type as PushAuditEntry["actorType"],
      ownerHandle: row.owner_handle ? String(row.owner_handle) : null,
      ref: String(row.ref),
      oldSha: String(row.old_sha),
      newSha: String(row.new_sha),
      allowed: Boolean(row.allowed),
      reason: String(row.reason),
      createdAt: String(row.created_at),
    }));
  }

  // ---- Webhooks ----

  createWebhookSubscription(input: {
    repoId: string;
    url: string;
    secret: string;
    events: WebhookEventType[];
    enabled?: boolean;
  }): WebhookSubscription {
    const id = newId("whk");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_subscriptions (id, repo_id, url, secret, events, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.repoId, input.url, input.secret, JSON.stringify(input.events), input.enabled === false ? 0 : 1, now);
    return this.listWebhookSubscriptions(input.repoId).find((w) => w.id === id)!;
  }

  listWebhookSubscriptions(repoId: string): WebhookSubscription[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_subscriptions WHERE repo_id = ? ORDER BY created_at ASC`)
      .all(repoId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      repoId: String(row.repo_id),
      url: String(row.url),
      secret: String(row.secret),
      events: JSON.parse(String(row.events)),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
    }));
  }

  recordWebhookDelivery(input: {
    subscriptionId: string;
    event: WebhookEventType;
    url: string;
    payload: Record<string, unknown>;
    statusCode: number | null;
    responseBody: string | null;
    error: string | null;
  }): WebhookDelivery {
    const id = newId("dlv");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, subscription_id, event, url, payload, status_code, response_body, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subscriptionId,
        input.event,
        input.url,
        JSON.stringify(input.payload),
        input.statusCode,
        input.responseBody,
        input.error,
        now,
      );
    return {
      id,
      ...input,
      createdAt: now,
    };
  }

  listWebhookDeliveries(limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      subscriptionId: String(row.subscription_id),
      event: row.event as WebhookEventType,
      url: String(row.url),
      payload: JSON.parse(String(row.payload)),
      statusCode: row.status_code !== null && row.status_code !== undefined ? Number(row.status_code) : null,
      responseBody: row.response_body ? String(row.response_body) : null,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
    }));
  }

  // ---- Diff Cache ----

  getCachedDiff(repoId: string, cacheKey: string): DiffFile[] | null {
    const row = this.db
      .prepare(`SELECT files FROM diff_cache WHERE repo_id = ? AND cache_key = ?`)
      .get(repoId, cacheKey) as { files: string } | undefined;
    return row ? (JSON.parse(row.files) as DiffFile[]) : null;
  }

  setCachedDiff(repoId: string, cacheKey: string, files: DiffFile[]): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO diff_cache (repo_id, cache_key, files, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(repoId, cacheKey, JSON.stringify(files), now);
  }
}
