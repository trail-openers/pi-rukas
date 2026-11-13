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
  author: { login: "dev" },
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
  author: { login: "dev" },
  mergeable: "TRUE",
  mergeStateStatus: "CLEAN",
  labels: [{ name: "enhancement", id: 9, color: "a2eeff" }],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
};

/** `gh pr checks N --json name,state,bucket` rows (gh 2.98.0; no isRequired). */
export const GH_CHECKS = [
  { name: "ci", state: "completed", bucket: "pass" },
  { name: "lint", state: "completed", bucket: "pass" },
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
  author: { username: "dev" },
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
  author: { username: "dev" },
  labels: ["enhancement"],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

/**
 * `glab api /projects/:id/merge_requests/:iid` (REST, snake_case). Carries
 * the four readiness fields the epic spec names, plus `diff_refs.head_sha`:
 * the normalized MR (`mapGlMr`) keeps no commit oid, so the raw reply is the
 * only place a caller can read which commit its verdict is about.
 */
export const GL_MR = {
  iid: 17,
  title: "A GitLab MR",
  description: "the MR body",
  state: "opened",
  web_url: "https://gitlab.com/acme/widget/-/merge_requests/17",
  source_branch: "feature/issue-17-x",
  target_branch: "main",
  author: { username: "dev" },
  labels: ["enhancement"],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  detailed_merge_status: "can_be_merged",
  has_conflicts: false,
  blocking_discussions_resolved: true,
  approvals_left: 0,
  diff_refs: { base_sha: "a".repeat(40), head_sha: "b".repeat(40), start_sha: "c".repeat(40) },
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

/**
 * `glab api /projects/:id/pipelines/:pid/jobs` rows (snake_case).
 *
 * `allow_failure` is a real field on every row of that endpoint, so the fixture
 * carries it: the merge-evidence gate grades an allow-failure `manual`/`skipped`
 * row as passing, and a fixture that omitted it would hide the difference
 * between "allowed to fail" and "the row did not say".
 */
export const GL_JOBS = [
  { name: "build", status: "success", allow_failure: false },
  { name: "test", status: "success", allow_failure: false },
];

/** `glab api /projects/:id` project row (snake_case). */
export const GL_PROJECT = {
  path_with_namespace: "acme/widget",
  web_url: "https://gitlab.com/acme/widget",
  default_branch: "main",
  merge_method: "squash",
  squash_option: "squash_and_commit",
};

// ── #2160 rows for the `forge_read` read surface ───────────────────────
// Each row is the exact payload the command builder in forge-commands.ts makes
// the CLI answer, so the read-coverage test pins the whole path (builder →
// exec seam → mapper) against the same fake the forge suites use.

/** `gh issue view N --json comments` — a single object, not a bare array. */
export const GH_ISSUE_COMMENTS = {
  comments: [
    {
      id: 11,
      body: "first note",
      html_url: "https://github.com/acme/widget/issues/42#issuecomment-11",
      created_at: "2026-09-03T00:00:00Z",
    },
  ],
};

/** `glab api /projects/:id/issues/:iid/notes` — a bare array. */
export const GL_ISSUE_NOTES = [
  {
    id: 21,
    body: "first note",
    web_url: "https://gitlab.com/acme/widget/-/issues/42#note_21",
    created_at: "2026-09-03T00:00:00Z",
  },
];

/** `gh pr view N --json comments`. */
export const GH_PR_COMMENTS = {
  comments: [
    {
      id: 31,
      body: "review note",
      html_url: "https://github.com/acme/widget/pull/17#issuecomment-31",
      created_at: "2026-09-04T00:00:00Z",
    },
  ],
};

/** `glab api /projects/:id/merge_requests/:iid/notes`. */
export const GL_MR_NOTES = [
  {
    id: 41,
    body: "review note",
    web_url: "https://gitlab.com/acme/widget/-/merge_requests/17#note_41",
    created_at: "2026-09-04T00:00:00Z",
  },
];

/** `gh issue list … --json number,title,state,url` rows — also the search rows. */
export const GH_ISSUE_LIST = [
  {
    number: 42,
    title: "A GitHub issue",
    state: "OPEN",
    url: "https://github.com/acme/widget/issues/42",
  },
];

/** `gh issue list --search … --json …` rows. */
export const GH_ISSUE_SEARCH = GH_ISSUE_LIST;

/** `glab issue list --output json` rows (snake_case). */
export const GL_ISSUE_LIST = [
  {
    iid: 42,
    title: "A GitLab issue",
    description: "the issue body",
    state: "opened",
    web_url: "https://gitlab.com/acme/widget/-/issues/42",
    author: { username: "dev" },
    labels: ["bug"],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  },
];

/** `glab issue list --search … --output json` rows. */
export const GL_ISSUE_SEARCH = GL_ISSUE_LIST;

/** `gh pr list --json …` rows. */
export const GH_PR_LIST = [
  {
    number: 17,
    title: "A GitHub PR",
    body: "the PR body",
    state: "OPEN",
    url: "https://github.com/acme/widget/pull/17",
    headRefName: "feature/issue-17-x",
    baseRefName: "main",
    labels: [],
  },
];

/** `glab mr list --output json` rows. */
export const GL_MR_LIST = [
  {
    iid: 17,
    title: "A GitLab MR",
    description: "the MR body",
    state: "opened",
    web_url: "https://gitlab.com/acme/widget/-/merge_requests/17",
    source_branch: "feature/issue-17-x",
    target_branch: "main",
    author: { username: "dev" },
    labels: [],
  },
];

/**
 * `n` well-formed rows of each list reply, for the cap tests: a list read that
 * answers EXACTLY its page size is the one case the child must be told about,
 * and hand-writing a hundred rows is not how anyone writes that case.
 */
export function ghIssueRows(n: number): unknown[] {
  return Array.from({ length: n }, (_unused, i) => ({
    number: 100 + i,
    title: `issue ${i}`,
    state: "OPEN",
    url: `https://github.com/acme/widget/issues/${100 + i}`,
  }));
}

/** `n` `gh pr list` rows. */
export function ghPrRows(n: number): unknown[] {
  return Array.from({ length: n }, (_unused, i) => ({
    number: 100 + i,
    title: `pr ${i}`,
    body: "",
    state: "OPEN",
    url: `https://github.com/acme/widget/pull/${100 + i}`,
    headRefName: `feature/issue-${i}`,
    baseRefName: "main",
    labels: [],
  }));
}

/** `n` `glab issue list` rows (snake_case). */
export function glIssueRows(n: number): unknown[] {
  return Array.from({ length: n }, (_unused, i) => ({
    iid: 100 + i,
    title: `issue ${i}`,
    description: "",
    state: "opened",
    web_url: `https://gitlab.com/acme/widget/-/issues/${100 + i}`,
    author: { username: "dev" },
    labels: [],
  }));
}

/** `n` `glab mr list` rows (snake_case). */
export function glMrRows(n: number): unknown[] {
  return Array.from({ length: n }, (_unused, i) => ({
    iid: 100 + i,
    title: `mr ${i}`,
    description: "",
    state: "opened",
    web_url: `https://gitlab.com/acme/widget/-/merge_requests/${100 + i}`,
    source_branch: `feature/issue-${i}`,
    target_branch: "main",
    author: { username: "dev" },
    labels: [],
  }));
}

/** `gh pr view N --json reviews` — one object carrying `reviews`. */
export const GH_PR_REVIEWS = {
  reviews: [
    {
      id: 51,
      author: { login: "reviewer" },
      state: "APPROVED",
      body: "LGTM",
      submittedAt: "2026-09-05T00:00:00Z",
    },
    {
      id: 52,
      author: { login: "second" },
      state: "CHANGES_REQUESTED",
      body: "",
      submittedAt: "2026-09-05T01:00:00Z",
    },
  ],
};

/** `glab api /projects/:id/merge_requests/:iid/approvals`. */
export const GL_MR_APPROVALS = {
  approved_by: [{ user: { username: "reviewer" }, created_at: "2026-09-05T00:00:00Z" }],
};

/** `gh api /repos/o/r/actions/runs/:id/jobs` rows (snake_case). */
export const GH_RUN_JOBS = [
  { id: 7001, name: "build", status: "completed", conclusion: "failure" },
  { id: 7002, name: "lint", status: "completed", conclusion: "success" },
];

/** The concatenated failed-job log `gh run view --log-failed` prints. */
export const GH_RUN_FAILED_LOG = "build  | error: expected 1 to be 2\n";

/** `glab api /projects/:id/pipelines/:pid/jobs` rows. */
export const GL_PIPELINE_JOBS = [
  { id: 8001, name: "build", status: "failed" },
  { id: 8002, name: "lint", status: "success" },
];

/** One GitLab job's trace rows (`glab api /projects/:id/jobs/:id/trace`). */
export const GL_JOB_TRACE = { id: 8001, name: "build", trace: "TRACE-MARKER-8001 FAILED test_x\n" };
