import { describe, expect, it } from "vitest";
import type { PrComment } from "@agentic-git/shared";
import { parseMarkdownBlocks } from "./markdown";
import { buildRoute, parseRoute } from "./routing";
import { groupCommentThreads } from "./threads";

describe("Phase 3 Web UI utilities", () => {
  it("parses and builds shareable GitHub-style URLs for repos, tabs, and PR sub-tabs", () => {
    expect(parseRoute("/")).toEqual({
      slug: "",
      repoTab: "pulls",
      prNum: null,
      prTab: "conversation",
    });
    expect(parseRoute("/acme/payments/pulls")).toEqual({
      slug: "acme/payments",
      repoTab: "pulls",
      prNum: null,
      prTab: "conversation",
    });
    expect(parseRoute("/acme/payments/pull/42")).toEqual({
      slug: "acme/payments",
      repoTab: "pulls",
      prNum: 42,
      prTab: "conversation",
    });
    expect(parseRoute("/acme/payments/pull/42/files")).toEqual({
      slug: "acme/payments",
      repoTab: "pulls",
      prNum: 42,
      prTab: "files",
    });
    expect(parseRoute("/acme/payments/pull/42/checks")).toEqual({
      slug: "acme/payments",
      repoTab: "pulls",
      prNum: 42,
      prTab: "checks",
    });
    expect(parseRoute("/acme/payments/settings")).toEqual({
      slug: "acme/payments",
      repoTab: "settings",
      prNum: null,
      prTab: "conversation",
    });

    expect(buildRoute({ slug: "acme/payments", repoTab: "pulls", prNum: 42, prTab: "files" })).toBe(
      "/acme/payments/pull/42/files",
    );
    expect(buildRoute({ slug: "acme/payments", repoTab: "pulls", prNum: 42, prTab: "conversation" })).toBe(
      "/acme/payments/pull/42",
    );
    expect(buildRoute({ slug: "acme/payments", repoTab: "activity", prNum: null, prTab: "conversation" })).toBe(
      "/acme/payments/activity",
    );
  });

  it("groups comment replies under their parent comment threads", () => {
    const base: Omit<PrComment, "id" | "parentId" | "body"> = {
      prId: "pr_1",
      authorActorId: "a1",
      authorHandle: "alice",
      authorType: "human",
      commentType: "blocking",
      metadata: {},
      resolved: false,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const comments: PrComment[] = [
      { ...base, id: "c1", parentId: null, body: "Root 1" },
      { ...base, id: "c2", parentId: "c1", body: "Reply to Root 1" },
      { ...base, id: "c3", parentId: null, body: "Root 2" },
      { ...base, id: "c4", parentId: "missing_parent", body: "Orphan fallback" },
    ];

    const threads = groupCommentThreads(comments);
    expect(threads.map((t) => t.root.id)).toEqual(["c1", "c3", "c4"]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["c2"]);
    expect(threads[1].replies).toEqual([]);
  });

  it("parses Markdown headings, fenced code blocks, task lists, and paragraphs", () => {
    const md = [
      "## Summary",
      "Fixes `charge()` timeout.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "- [x] Unit tests",
      "- [ ] Follow-up cleanup",
    ].join("\n");
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Summary")).toBe(true);
    expect(blocks.some((b) => b.kind === "code" && b.code.includes("const x = 1;"))).toBe(true);
    expect(blocks.some((b) => b.kind === "list" && b.items.length === 2 && b.items[0].checked === true)).toBe(true);
  });
});
