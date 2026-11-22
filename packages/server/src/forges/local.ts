import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CiCheck, DiffFile, MergeMethod } from "@agentic-git/shared";
import type { RepoRowInternal } from "../db.js";
import { MergeConflictError, type ForgeAdapter, type ShadowPrResult } from "./types.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Local bare-repo ForgeAdapter.
 * Operates against a real bare Git repository on disk (repo.upstreamRepo = bare repo path).
 * Performs genuine `git diff`, `git rev-parse`, and real merges into the target branch,
 * making it ideal for local development, offline testing, and self-hosted bare Git mirrors.
 */
export class LocalGitForgeAdapter implements ForgeAdapter {
  private shadowCounter = 0;

  async createShadowPr(
    repo: RepoRowInternal,
    _token: string,
    params: { title: string; description: string; sourceBranch: string; targetBranch: string },
  ): Promise<ShadowPrResult> {
    this.shadowCounter += 1;
    const id = `local-${this.shadowCounter}`;
    const headSha = await this.getBranchHeadSha(repo, "", params.sourceBranch);
    return {
      upstreamPrId: id,
      upstreamPrUrl: `${repo.forgeBaseUrl || "local://upstream"}/${repo.slug}/pulls/${id}`,
      headSha: headSha ?? undefined,
    };
  }

  async closeShadowPr(): Promise<void> {
    // No remote state to tear down for local bare repo
  }

  async getBranchHeadSha(
    repo: RepoRowInternal,
    _token: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const out = await runGit(repo.upstreamRepo, ["rev-parse", `refs/heads/${branch}`]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async getPrDiff(
    repo: RepoRowInternal,
    _token: string,
    params: { upstreamPrId?: string | null; sourceBranch: string; targetBranch: string },
  ): Promise<DiffFile[]> {
    const bareDir = repo.upstreamRepo;
    const range = `refs/heads/${params.targetBranch}...refs/heads/${params.sourceBranch}`;

    const nameStatusOut = await runGit(bareDir, ["diff", "--name-status", range]);
    const numstatOut = await runGit(bareDir, ["diff", "--numstat", range]);

    const numMap = new Map<string, { additions: number; deletions: number }>();
    for (const line of numstatOut.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const adds = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
        const dels = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
        const filePath = parts[parts.length - 1];
        numMap.set(filePath, { additions: adds, deletions: dels });
      }
    }

    const files: DiffFile[] = [];
    for (const line of nameStatusOut.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const code = parts[0];
      let status: DiffFile["status"] = "modified";
      let filePath = parts[1];
      let oldPath: string | null = null;

      if (code.startsWith("A")) status = "added";
      else if (code.startsWith("D")) status = "deleted";
      else if (code.startsWith("R")) {
        status = "renamed";
        oldPath = parts[1];
        filePath = parts[2];
      }

      const patch = await runGit(bareDir, ["diff", range, "--", filePath]);
      const counts = numMap.get(filePath) ?? { additions: 0, deletions: 0 };
      files.push({
        path: filePath,
        oldPath,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        patch,
      });
    }

    return files;
  }

  async getCommitChecks(): Promise<CiCheck[]> {
    // Local forge CI checks are pushed via the CI webhook/sync endpoint
    return [];
  }

  async mergePr(
    repo: RepoRowInternal,
    _token: string,
    params: {
      upstreamPrId?: string | null;
      sourceBranch: string;
      targetBranch: string;
      commitTitle: string;
      mergeMethod?: MergeMethod;
    },
  ): Promise<{ mergedSha: string }> {
    const bareDir = repo.upstreamRepo;
    const mergeMethod = params.mergeMethod ?? repo.mergePolicy.mergeMethod ?? "merge";
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agit-merge-"));
    try {
      await runGit(tmpDir, ["clone", "--branch", params.targetBranch, bareDir, "."]);
      await runGit(tmpDir, ["config", "user.name", "agentic-git"]);
      await runGit(tmpDir, ["config", "user.email", "merge@agentic-git.local"]);
      try {
        if (mergeMethod === "squash") {
          await runGit(tmpDir, ["merge", "--squash", `origin/${params.sourceBranch}`]);
          await runGit(tmpDir, ["commit", "-m", params.commitTitle]);
        } else if (mergeMethod === "rebase") {
          await runGit(tmpDir, ["checkout", "-b", "__agit_rebase__", `origin/${params.sourceBranch}`]);
          await runGit(tmpDir, ["rebase", params.targetBranch]);
          await runGit(tmpDir, ["checkout", params.targetBranch]);
          await runGit(tmpDir, ["merge", "--ff-only", "__agit_rebase__"]);
        } else {
          await runGit(tmpDir, [
            "merge",
            "--no-ff",
            `origin/${params.sourceBranch}`,
            "-m",
            params.commitTitle,
          ]);
        }
      } catch (err) {
        let conflictingFiles: string[] = [];
        try {
          const out = await runGit(tmpDir, ["diff", "--name-only", "--diff-filter=U"]);
          conflictingFiles = out
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        } catch {
          // ignore secondary inspection failure
        }
        if (conflictingFiles.length > 0 || (err instanceof Error && /conflict|merge|rebase/i.test(err.message))) {
          throw new MergeConflictError(
            conflictingFiles.length > 0
              ? `Merge conflict in ${conflictingFiles.join(", ")}`
              : `Merge conflict merging '${params.sourceBranch}' into '${params.targetBranch}'`,
            conflictingFiles,
          );
        }
        throw err;
      }
      await runGit(tmpDir, ["push", "origin", params.targetBranch]);
      const mergedSha = (await runGit(tmpDir, ["rev-parse", "HEAD"])).trim();
      return { mergedSha };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}
