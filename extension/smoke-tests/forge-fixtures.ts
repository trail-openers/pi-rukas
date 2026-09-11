/**
 * forge-fixtures — side-effect-free fixtures shared by the forge S2 smoke
 * tests (test-forge-github.ts, test-forge-gitlab.ts, test-forge-merge-
 * readiness.ts, test-forge-ci-watch.ts).
 *
 * Extracted so each test imports the typed fixtures WITHOUT executing the
 * other tests' top-level assertions and `process.exit` — importing an
 * executable test file runs it (the work-driver-merged-fixtures.ts
 * precedent, issue #356).
 *
 * This module MUST stay free of assertions, top-level execution, and
 * process.exit.
 */

import type { ForgeDetection } from "../src/forge-detect.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";

/**
 * A `mkExec`-style command-substring fake, with a calls array.
 *
 * `opts` records the exec options object passed to the fake per call,
 * positionally aligned with `calls` (issue #636: tests need to observe
 * the `timeout` applied at readiness call sites). The `calls` array keeps
 * its string shape for the existing seven consumers.
 */
export function mkExec(
  o: Record<string, { stdout?: string; stderr?: string; error?: boolean }> = {},
): { fn: VerifyExecFn; calls: string[]; opts: Array<Record<string, unknown> | undefined> } {
  const calls: string[] = [];
  const opts: Array<Record<string, unknown> | undefined> = [];
  const fn: VerifyExecFn = async (cmd, o2) => {
    calls.push(cmd);
    opts.push(o2 as Record<string, unknown> | undefined);
    for (const [k, v] of Object.entries(o)) {
      if (cmd.includes(k)) {
        if (v.error) {
          const e = new Error(v.stderr ?? "err") as Error & { stderr?: string };
          e.stderr = v.stderr;
          throw e;
        }
        return { stdout: v.stdout ?? "", stderr: v.stderr };
      }
    }
    return { stdout: "" };
  };
  return { fn, calls, opts };
}

/** GitHub detection: github.com, owner/repo from the URL. */
export function ghDetection(owner: string, repo: string): ForgeDetection {
  return {
    forge: "github",
    host: "github.com",
    remote: "origin",
    url: `https://github.com/${owner}/${repo}.git`,
    source: "known-host",
  };
}

/** GitLab detection: gitlab.com, owner/repo from the URL. */
export function glDetection(owner: string, repo: string): ForgeDetection {
  return {
    forge: "gitlab",
    host: "gitlab.com",
    remote: "origin",
    url: `https://gitlab.com/${owner}/${repo}.git`,
    source: "known-host",
  };
}

// ── GitHub JSON fixtures (camelCase, GraphQL --json convention) ──────────

/** `gh issue view N --json …` (camelCase). */
export const GH_ISSUE = {
  number: 42,
  title: "A GitHub issue",
  body: "the issue body",
  state: "OPEN",
  url: "https://github.com/acme/widget/issues/42",
  author: { login: "janni" },
  labels: [{ name: "bug", id: 7, color: "d73a4a", description: "a bug" }],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
};

/** `gh pr view N --json …` (camelCase). */
export const GH_PR = {
  number: 17,
  title: "A GitHub PR",
  body: "the PR body",
  state: "OPEN",
  url: "https://github.com/acme/widget/pull/17",
  headRefName: "feature/issue-17-x",
  baseRefName: "main",
  author: { login: "janni" },
  mergeable: "TRUE",
  mergeStateStatus: "CLEAN",
  labels: [{ name: "enhancement", id: 9, color: "a2eeff" }],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
};

/** `gh pr checks N --json name,state,bucket,isRequired` rows. */
export const GH_CHECKS = [
  { name: "ci", state: "completed", bucket: "pass", isRequired: true },
  { name: "lint", state: "completed", bucket: "pass", isRequired: true },
];

/** `gh api /repos/o/r/actions/runs/:id` (REST snake_case). */
export const GH_RUN_RUNNING = {
  database_id: 901,
  name: "CI",
  status: "in_progress",
  conclusion: null,
  url: "https://github.com/acme/widget/actions/runs/901",
  head_branch: "feature/issue-17-x",
};

export const GH_RUN_DONE = {
  database_id: 901,
  name: "CI",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/acme/widget/actions/runs/901",
  head_branch: "feature/issue-17-x",
};

/** `gh repo view --json …` (camelCase). */
export const GH_REPO = {
  nameWithOwner: "acme/widget",
  url: "https://github.com/acme/widget",
  defaultBranchRef: { name: "main" },
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
};

// ── GitLab JSON fixtures (snake_case, uniform convention) ────────────────

/** `glab issue view N --output json` (snake_case). */
export const GL_ISSUE = {
  iid: 42,
  title: "A GitLab issue",
  description: "the issue body",
  state: "opened",
  web_url: "https://gitlab.com/acme/widget/-/issues/42",
  author: { username: "janni" },
  labels: ["bug"],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

/**
 * `glab mr view N --output json` (snake_case). Does NOT include the four
 * readiness fields — those come from the REST API (`glab api`), not the
 * view command. The readiness path uses the REST API directly.
 */
export const GL_MR_VIEW = {
  iid: 17,
  title: "A GitLab MR",
  description: "the MR body",
  state: "opened",
  web_url: "https://gitlab.com/acme/widget/-/merge_requests/17",
  source_branch: "feature/issue-17-x",
  target_branch: "main",
  author: { username: "janni" },
  labels: ["enhancement"],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

/**
 * `glab api /projects/:id/merge_requests/:iid` (REST, snake_case). Carries
 * the four readiness fields the epic spec names.
 */
export const GL_MR = {
  iid: 17,
  title: "A GitLab MR",
  description: "the MR body",
  state: "opened",
  web_url: "https://gitlab.com/acme/widget/-/merge_requests/17",
  source_branch: "feature/issue-17-x",
  target_branch: "main",
  author: { username: "janni" },
  labels: ["enhancement"],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  detailed_merge_status: "can_be_merged",
  has_conflicts: false,
  blocking_discussions_resolved: true,
  approvals_left: 0,
  open_pipeline: { id: 5001, status: "running" },
};

/** A MR in `checking` state (retryable UNKNOWN). */
export const GL_MR_CHECKING = {
  ...GL_MR,
  detailed_merge_status: "checking",
  has_conflicts: false,
  blocking_discussions_resolved: true,
  approvals_left: 0,
};

/** `glab api /projects/:id/pipelines/:pid` (snake_case). */
export const GL_PIPELINE_RUNNING = {
  id: 5001,
  name: null,
  status: "running",
  web_url: "https://gitlab.com/acme/widget/-/pipelines/5001",
  ref: "feature/issue-17-x",
};

export const GL_PIPELINE_DONE = {
  id: 5001,
  name: null,
  status: "success",
  web_url: "https://gitlab.com/acme/widget/-/pipelines/5001",
  ref: "feature/issue-17-x",
};

/** `glab api /projects/:id/pipelines/:pid/jobs` rows (snake_case). */
export const GL_JOBS = [
  { name: "build", status: "success" },
  { name: "test", status: "success" },
];

/** `glab api /projects/:id` project row (snake_case). */
export const GL_PROJECT = {
  path_with_namespace: "acme/widget",
  web_url: "https://gitlab.com/acme/widget",
  default_branch: "main",
  merge_method: "squash",
  squash_option: "squash_and_commit",
};
