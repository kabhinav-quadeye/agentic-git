import type { ForgeType } from "@agentic-git/shared";
import { GitHubForgeAdapter } from "./github.js";
import { GitLabForgeAdapter } from "./gitlab.js";
import { LocalGitForgeAdapter } from "./local.js";
import type { ForgeAdapter } from "./types.js";

export type { ForgeAdapter, ShadowPrResult, UpstreamPrInfo } from "./types.js";
export { MergeConflictError } from "./types.js";
export { GitHubForgeAdapter, GitLabForgeAdapter, LocalGitForgeAdapter };

export class ForgeRegistry {
  private readonly adapters = new Map<ForgeType, ForgeAdapter>();

  constructor(overrides?: Partial<Record<ForgeType, ForgeAdapter>>) {
    this.adapters.set("github", overrides?.github ?? new GitHubForgeAdapter());
    this.adapters.set("gitlab", overrides?.gitlab ?? new GitLabForgeAdapter());
    this.adapters.set("local", overrides?.local ?? new LocalGitForgeAdapter());
  }

  get(forgeType: ForgeType): ForgeAdapter {
    const adapter = this.adapters.get(forgeType);
    if (!adapter) {
      throw new Error(`Unsupported forge type: ${forgeType}`);
    }
    return adapter;
  }
}
