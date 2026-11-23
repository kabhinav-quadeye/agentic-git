import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForgeType } from "@agentic-git/shared";

export interface AgitConfig {
  serverUrl: string;
  token: string;
}

export interface ParsedGitRemote {
  slug: string;
  forgeType: ForgeType;
  host: string;
}

export function getConfigPath(): string {
  const dir = process.env.AGIT_CONFIG_DIR ?? path.join(os.homedir(), ".config", "agentic-git");
  return path.join(dir, "config.json");
}

export function loadConfig(overrides?: { server?: string; token?: string }): AgitConfig {
  let fileCfg: Partial<AgitConfig> = {};
  const cfgPath = getConfigPath();
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<AgitConfig>;
    } catch {
      fileCfg = {};
    }
  }
  const envServer = process.env.AGIT_URL?.trim() || undefined;
  const envToken = process.env.AGIT_TOKEN?.trim() || undefined;
  const serverUrl = (
    overrides?.server?.trim() ||
    envServer ||
    fileCfg.serverUrl ||
    "http://127.0.0.1:4321"
  ).replace(/\/+$/, "");
  const token = overrides?.token?.trim() || envToken || fileCfg.token || "";
  return { serverUrl, token };
}

export function saveConfig(cfg: Partial<AgitConfig>): AgitConfig {
  const current = loadConfig();
  const next: AgitConfig = {
    serverUrl: (cfg.serverUrl ?? current.serverUrl).replace(/\/+$/, ""),
    token: cfg.token ?? current.token,
  };
  const cfgPath = getConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

function classifyForgeHost(host: string): ForgeType {
  const lower = host.toLowerCase();
  if (lower.includes("github")) return "github";
  if (lower.includes("gitlab")) return "gitlab";
  return "local";
}

/**
 * Parses agentic-git proxy URLs, GitHub/GitLab HTTPS URLs, and SSH URLs into `{ slug, forgeType, host }`.
 */
export function parseGitRemoteUrl(remoteUrl: string): ParsedGitRemote | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  // 1. agentic-git proxy URL: http(s)://[user:pass@]host[:port]/git/<org>/<repo>[.git]
  const agitMatch = trimmed.match(
    /^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/git\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?\/?$/,
  );
  if (agitMatch) {
    return { slug: agitMatch[2], forgeType: "local", host: agitMatch[1] };
  }

  // 2. SCP-style SSH URL: git@github.com:org/repo.git
  const scpMatch = trimmed.match(
    /^(?:[^@:\s]+@)?([^:\s/]+):([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?\/?$/,
  );
  if (scpMatch) {
    return {
      slug: scpMatch[2],
      forgeType: classifyForgeHost(scpMatch[1]),
      host: scpMatch[1],
    };
  }

  // 3. Standard HTTP(S) or ssh:// URL
  try {
    const parsed = new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const slug = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
      return {
        slug,
        forgeType: classifyForgeHost(parsed.host),
        host: parsed.host,
      };
    }
  } catch {
    // not a URL (e.g. local filesystem path)
  }

  return null;
}

export function getGitRemoteUrl(remoteName: string, cwd = process.cwd()): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", remoteName], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

/**
 * Infers `<org>/<repo>` from git remotes, preferring `agit` over `origin`,
 * and supporting agentic-git proxy URLs as well as GitHub/GitLab HTTPS & SSH URLs.
 */
export function inferRepoSlugFromGit(cwd = process.cwd()): string | null {
  for (const remoteName of ["agit", "origin"]) {
    const url = getGitRemoteUrl(remoteName, cwd);
    if (!url) continue;
    const parsed = parseGitRemoteUrl(url);
    if (parsed) return parsed.slug;
  }
  return null;
}

export function inferCurrentBranch(cwd = process.cwd()): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export function inferDefaultBranch(cwd = process.cwd()): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // fallback
  }
  return "main";
}

export function getHeadCommitSummary(cwd = process.cwd()): { title: string; body: string } | null {
  try {
    const title = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const body = execFileSync("git", ["log", "-1", "--format=%b"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return title ? { title, body } : null;
  } catch {
    return null;
  }
}

export function tryReadGhAuthToken(): string | null {
  try {
    const tok = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return tok || null;
  } catch {
    return null;
  }
}

export function getPreferredGitRemote(cwd = process.cwd()): string {
  if (getGitRemoteUrl("agit", cwd)) return "agit";
  return "origin";
}

export function pushBranchToGitRemote(
  branch: string,
  cwd = process.cwd(),
  remoteName?: string,
): void {
  const remote = remoteName ?? getPreferredGitRemote(cwd);
  execFileSync("git", ["push", "-u", remote, branch], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function checkoutBranchFromGitRemote(
  branch: string,
  cwd = process.cwd(),
  remoteName?: string,
): void {
  const remote = remoteName ?? getPreferredGitRemote(cwd);
  execFileSync("git", ["fetch", remote, branch], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    execFileSync("git", ["checkout", branch], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    execFileSync("git", ["checkout", "-b", branch, `${remote}/${branch}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

export function setupGitCredentialHelper(serverUrl: string): void {
  const origin = new URL(serverUrl).origin;
  execFileSync(
    "git",
    ["config", "--global", `credential.${origin}.helper`, "!agit git-credential"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
