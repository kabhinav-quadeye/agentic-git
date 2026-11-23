import type { PrComment } from "@agentic-git/shared";

export interface CommentThread {
  root: PrComment;
  replies: PrComment[];
}

export function groupCommentThreads(comments: PrComment[]): CommentThread[] {
  const byId = new Map<string, PrComment>();
  for (const c of comments) byId.set(c.id, c);

  const threadByRootId = new Map<string, CommentThread>();
  const orderedThreads: CommentThread[] = [];

  for (const c of comments) {
    if (!c.parentId || !byId.has(c.parentId)) {
      const thread: CommentThread = { root: c, replies: [] };
      threadByRootId.set(c.id, thread);
      orderedThreads.push(thread);
    }
  }

  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      // Walk up to top-level root if nested more than 1 level
      let rootId = c.parentId;
      const seen = new Set<string>([c.id]);
      while (rootId && byId.get(rootId)?.parentId && !seen.has(rootId)) {
        seen.add(rootId);
        const nextParent = byId.get(rootId)?.parentId;
        if (nextParent && byId.has(nextParent)) rootId = nextParent;
        else break;
      }
      const thread = threadByRootId.get(rootId);
      if (thread) {
        thread.replies.push(c);
      } else {
        orderedThreads.push({ root: c, replies: [] });
      }
    }
  }

  return orderedThreads;
}
