import type { CiCheck, DiffFile, MergeMethod } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";

export class MergeConflictError extends Error {
  readonly statusCode = 409;
  readonly conflictingFiles: string[];

  constructor(message: string, conflictingFiles: string[] = []) {
    super(message);
    this.name = "MergeConflictError";
    this.conflictingFiles = conflictingFiles;
  }
}

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
      mergeMethod?: MergeMethod;
    },
  ): Promise<{ mergedSha: string }>;
}
