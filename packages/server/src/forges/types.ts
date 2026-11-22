import type { CiCheck, DiffFile } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";

export interface ShadowPrResult {
  upstreamPrId: string;
  upstreamPrUrl: string;
  headSha?: string;
}

export interface ForgeAdapter {
  createShadowPr(
    repo: RepoRowInternal,
    token: string,
    params: {
      title: string;
      description: string;
      sourceBranch: string;
      targetBranch: string;
    },
  ): Promise<ShadowPrResult>;

  closeShadowPr(repo: RepoRowInternal, token: string, upstreamPrId: string): Promise<void>;

  getBranchHeadSha(repo: RepoRowInternal, token: string, branch: string): Promise<string | null>;

  getPrDiff(
    repo: RepoRowInternal,
    token: string,
    params: {
      upstreamPrId?: string | null;
      sourceBranch: string;
      targetBranch: string;
    },
  ): Promise<DiffFile[]>;

  getCommitChecks(repo: RepoRowInternal, token: string, sha: string): Promise<CiCheck[]>;

  mergePr(
    repo: RepoRowInternal,
    token: string,
    params: {
      upstreamPrId?: string | null;
      sourceBranch: string;
      targetBranch: string;
      commitTitle: string;
    },
  ): Promise<{ mergedSha: string }>;
}
