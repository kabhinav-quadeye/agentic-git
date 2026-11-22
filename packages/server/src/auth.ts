import { matchAnyGlob } from "@agentic-git/shared";
import type { ActorRowInternal, RepoRowInternal, Store } from "./db.js";

/**
 * Extracts an agentic-git API/Git token from either:
 * - Authorization: Bearer <token>
 * - Authorization: Basic base64(user:pass)  (accepts token in password OR username)
 * - X-Agentic-Token: <token>
 */
export function extractTokenFromHeaders(headers: Headers): string | null {
  const xToken = headers.get("x-agentic-token");
  if (xToken?.trim()) return xToken.trim();

  const auth = headers.get("authorization");
  if (!auth) return null;

  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }

  if (auth.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return decoded.trim() || null;
    const user = decoded.slice(0, idx).trim();
    const pass = decoded.slice(idx + 1).trim();
    // Git clients commonly pass token as password (e.g. https://bot:agit_bot_xxx@host/...)
    // or as username with empty password (e.g. https://agit_bot_xxx@host/...)
    if (pass) return pass;
    if (user) return user;
  }

  return null;
}

/**
 * Resolves which upstream GitHub/GitLab credential to use for a given repo and actor.
 * - In "service" mode: uses repo.upstreamToken (single service/repo token).
 * - In "per_user" mode: uses actor's own upstreamToken, or if the actor is an agent bot,
 *   inherits its human owner's upstreamToken — falling back to repo.upstreamToken.
 */
export function resolveUpstreamToken(
  store: Store,
  repo: RepoRowInternal,
  actor: ActorRowInternal,
): string {
  if (repo.credentialMode === "per_user") {
    if (actor.upstreamToken) return actor.upstreamToken;
    if (actor.ownerId) {
      const owner = store.getActorById(actor.ownerId);
      if (owner?.upstreamToken) return owner.upstreamToken;
    }
  }
  return repo.upstreamToken;
}

export interface BranchPushDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Enforces branch protection and per-actor allowed branch globs on git push.
 */
export function checkBranchPushPermission(
  repo: RepoRowInternal,
  actor: ActorRowInternal,
  ref: string,
  newSha: string,
): BranchPushDecision {
  const isTag = ref.startsWith("refs/tags/");
  if (isTag) {
    if (actor.type === "agent" && actor.role !== "admin") {
      return { allowed: false, reason: `Agent '${actor.handle}' is not allowed to push tags (${ref})` };
    }
    return { allowed: true, reason: "Tag push permitted" };
  }

  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const isDelete = /^0+$/.test(newSha);

  // Protected branch check: NOBODY (not even developers or agents) can push directly
  // to protected branches; merges must go through the PR merge gate!
  // Only an admin human can bypass protected branch push if explicitly needed.
  if (matchAnyGlob(branch, repo.protectedBranches)) {
    if (isDelete) {
      return {
        allowed: false,
        reason: `Protected branch '${branch}' cannot be deleted via git push`,
      };
    }
    if (!(actor.type === "human" && actor.role === "admin")) {
      return {
        allowed: false,
        reason: `Direct push to protected branch '${branch}' is blocked by agentic-git. Open a PR and satisfy merge gates instead.`,
      };
    }
  }

  // Per-actor branch pattern enforcement (e.g. agents restricted to agent/* or feature/*)
  if (!matchAnyGlob(branch, actor.allowedBranchPatterns)) {
    return {
      allowed: false,
      reason: `Actor '${actor.handle}' is only allowed to push branches matching [${actor.allowedBranchPatterns.join(", ")}], not '${branch}'`,
    };
  }

  return { allowed: true, reason: "Allowed" };
}
