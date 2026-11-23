export type RepoTab = "pulls" | "activity" | "settings";
export type PrTab = "conversation" | "checks" | "files";

export interface AppRouteState {
  slug: string;
  repoTab: RepoTab;
  prNum: number | null;
  prTab: PrTab;
}

export function parseRoute(pathname: string): AppRouteState {
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  if (parts.length < 2) {
    return { slug: "", repoTab: "pulls", prNum: null, prTab: "conversation" };
  }

  const slug = `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`;
  const section = parts[2] ?? "pulls";

  if (section === "activity") {
    return { slug, repoTab: "activity", prNum: null, prTab: "conversation" };
  }
  if (section === "settings") {
    return { slug, repoTab: "settings", prNum: null, prTab: "conversation" };
  }
  if (section === "pull" && parts[3] && /^\d+$/.test(parts[3])) {
    const prNum = Number.parseInt(parts[3], 10);
    const sub = parts[4];
    const prTab: PrTab =
      sub === "files" ? "files" : sub === "checks" ? "checks" : "conversation";
    return { slug, repoTab: "pulls", prNum, prTab };
  }

  return { slug, repoTab: "pulls", prNum: null, prTab: "conversation" };
}

export function buildRoute(state: AppRouteState): string {
  if (!state.slug) return "/";
  const [org, repo] = state.slug.split("/");
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  if (state.repoTab === "activity") return `${base}/activity`;
  if (state.repoTab === "settings") return `${base}/settings`;
  if (state.prNum !== null) {
    const suffix = state.prTab === "conversation" ? "" : `/${state.prTab}`;
    return `${base}/pull/${state.prNum}${suffix}`;
  }
  return `${base}/pulls`;
}
