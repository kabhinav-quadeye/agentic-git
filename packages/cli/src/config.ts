import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgitConfig {
  serverUrl: string;
  token: string;
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
  const serverUrl = (
    overrides?.server ??
    process.env.AGIT_URL ??
    fileCfg.serverUrl ??
    "http://127.0.0.1:4321"
  ).replace(/\/+$/, "");
  const token = overrides?.token ?? process.env.AGIT_TOKEN ?? fileCfg.token ?? "";
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

/**
 * Infers `<org>/<repo>` from `git remote get-url origin` when pointed at an agentic-git URL:
 * e.g. `http://bot:tok@127.0.0.1:4321/git/demo/app.git` -> `demo/app`
 */
export function inferRepoSlugFromGit(cwd = process.cwd()): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/\/git\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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
