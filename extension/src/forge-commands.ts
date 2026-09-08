/**
 * forge-commands — pure command-string builders for the gh/glab adapter
 * (S2 of epic #608).
 *
 * Keeping the argv shaping here (instead of inline in the forge.ts methods)
 * lets the offline smoke tests assert the EXACT command string the
 * production path would execute — including the load-bearing invariants
 * (e.g. GitLab MR merge MUST carry `--auto-merge=false`).
 */

import type { ForgeType } from "./forge-detect.ts";

/** Shell-quote a single argument (the command seam is a shell string). */
export function shq(arg: string): string {
  if (/^[A-Za-z0-9_@.\/:=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// ── Issues ────────────────────────────────────────────────────────────────

export function issueViewCmd(forge: ForgeType, number: number): string {
  if (forge === "github")
    return `gh issue view ${number} --json number,title,body,state,url,author,labels,createdAt,updatedAt`;
  return `glab issue view ${number} --output json`;
}

/**
 * `gh issue create` does NOT support `--json` (verified: `gh issue create
 * --help` — the flag list has no `--json`). On success gh prints the created
 * issue's URL as a single plain-text line to stdout. The mapper in `forge.ts`
 * (`issueCreate`) parses that line into a NormalizedIssue via
 * `parsePrNumberFromResponse` (which handles both `/issues/N` and
 * `/-/merge_requests/N` URL shapes, and also tolerates a JSON payload for
 * forward-compat with a `gh` release that adds `--json` to create).
 */
export function issueCreateCmd(forge: ForgeType, title: string, bodyFile: string): string {
  if (forge === "github")
    return `gh issue create --title ${shq(title)} --body-file ${shq(bodyFile)}`;
  // glab issue create takes the description as a literal string. The file
  // content is expanded by the caller (the forge object reads the file and
  // passes the content); the `-d` value here is the *expanded* content.
  return `glab issue create -t ${shq(title)} -d ${shq(`@${bodyFile}`)}`;
}

export function issueCommentCmd(forge: ForgeType, number: number, bodyFile: string): string {
  if (forge === "github") return `gh issue comment ${number} --body-file ${shq(bodyFile)}`;
  return `glab api --method POST --header "Content-Type: application/json" -f "body=@${bodyFile}" /projects/:id/issues/${number}/notes`;
}

export function issueSearchCmd(forge: ForgeType, query: string): string {
  if (forge === "github")
    return `gh issue list --search ${shq(query)} --json number,title,state,url`;
  return `glab issue list --search ${shq(query)} --output json`;
}

/**
 * Issue edit. GitHub: `gh issue edit` (supports `--body-file`).
 * GitLab: NO body-file flag — the issue spec (epic #608) mandates
 * `glab api -X PUT` with the description passed via `description=@file`,
 * which glab expands to the file's content as the field value.
 */
export function issueEditCmd(forge: ForgeType, number: number, bodyFile?: string): string {
  if (forge === "github") return `gh issue edit ${number} --body-file ${shq(bodyFile ?? "")}`;
  return `glab api -X PUT -f "description=@${shq(bodyFile ?? "")}" /projects/:id/issues/${number}`;
}

// ── Pull requests / MRs ───────────────────────────────────────────────────

export function prViewCmd(forge: ForgeType, number: number): string {
  if (forge === "github") {
    return `gh pr view ${number} --json number,title,body,state,url,headRefName,baseRefName,author,mergeable,mergeStateStatus,labels,createdAt,updatedAt`;
  }
  return `glab mr view ${number} --output json`;
}

export function prListCmd(
  forge: ForgeType,
  opts: { state?: string; sourceBranch?: string } = {},
): string {
  const stateFlag = opts.state ? ` --state ${shq(opts.state)}` : "";
  if (forge === "github") {
    const head = opts.sourceBranch ? ` --head ${shq(opts.sourceBranch)}` : "";
    return `gh pr list${stateFlag}${head} --json number,title,state,url,headRefName,baseRefName,labels`;
  }
  const source = opts.sourceBranch ? ` --source-branch ${shq(opts.sourceBranch)}` : "";
  return `glab mr list${stateFlag}${source} --output json`;
}

/**
 * `gh pr create` does NOT support `--json` (verified: `gh pr create --help`
 * — no `--json` in the flag list, and the doc text explicitly states
 * "Upon success, the URL of the created pull request will be printed").
 * The mapper in `forge.ts` (`prCreate`) already handles the plain-text URL
 * shape via `parsePrNumberFromResponse` + `makeMinimalPr`; the trailing
 * `makeMinimalPr` fallback fills in `url` from the parsed value.
 */
export function prCreateCmd(
  forge: ForgeType,
  title: string,
  headBranch: string,
  bodyFile: string,
  baseBranch?: string,
): string {
  if (forge === "github") {
    const head = baseBranch ? `${shq(baseBranch)}...${shq(headBranch)}` : shq(headBranch);
    return `gh pr create --title ${shq(title)} --head ${head} --body-file ${shq(bodyFile)}`;
  }
  // GitLab: NO --head flag — the source branch is positional, and the
  // target is `--target-branch`.
  const target = baseBranch ? ` --target-branch ${shq(baseBranch)}` : "";
  return `glab mr create ${shq(headBranch)} -t ${shq(title)} --description-file ${shq(bodyFile)}${target} --output json`;
}

/**
 * MR/PR merge. SAFETY INVARIANT (epic #608): on GitLab this MUST always
 * pass `--auto-merge=false`. `glab mr merge` enables scheduled auto-merge
 * when auto-merge is configured for the MR, deferring the actual merge to a
 * GitLab pipeline trigger — the driver would then record "merged" for a MR
 * that has not merged. `--auto-merge=false` forces the immediate, explicit
 * merge. There is no GitHub analogue (gh pr merge merges immediately).
 */
export function prMergeCmd(
  forge: ForgeType,
  number: number,
  method: "squash" | "merge" | "rebase" = "squash",
): string {
  if (forge === "github") return `gh pr merge ${number} --${method} --delete-branch`;
  return `glab mr merge ${number} --${method} --auto-merge=false`;
}

export function prDiffCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr diff ${number}`;
  return `glab mr diff ${number}`;
}

/**
 * CI checks for a PR/MR.
 *
 * GitHub: `gh pr checks` exits non-zero when any check fails — callers must
 * tolerate that (the existing driver does). GitLab: `glab ci lint` is
 * static analysis and NOT run-level checks, so we go through the API:
 * the MR's open pipeline's jobs, via `glab api` against
 * `/projects/:id/merge_requests/:iid/pipelines` (first entry = most recent).
 */
export function prChecksCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr checks ${number} --json name,state,bucket,isRequired`;
  return `glab api "/projects/:id/merge_requests/${number}/pipelines" --output json`;
}

// ── CI runs ───────────────────────────────────────────────────────────────

/** Watch a GitHub Actions run (the CLI does the polling). */
export function ciWatchCmd(runId: number): string {
  return `gh run watch ${runId}`;
}

/**
 * Fetch one GitLab pipeline by id (the GitLab watch is a 30s polling loop;
 * this is one iteration of it). `:id` is the *project* id — glab expands it.
 */
export function pipelineViewCmd(pipelineId: number): string {
  return `glab api /projects/:id/pipelines/${pipelineId} --output json`;
}

/** List the project's pipelines (newest first) — the watch's entry point. */
export function pipelineListCmd(limit = 1): string {
  return `glab api "/projects/:id/pipelines?per_page=${limit}" --output json`;
}

// ── Labels ────────────────────────────────────────────────────────────────

/** Create a label (GitLab auto-creates missing labels on add, but explicit create is the normalized path). */
export function labelCreateCmd(forge: ForgeType, name: string, color: string): string {
  if (forge === "github") return `gh label create ${shq(name)} --color ${shq(color)} --force`;
  return `glab api -X POST -f "name=${shq(name)}" -f "color=%23${shq(color)}" /projects/:id/labels`;
}

/**
 * Add a label to an issue. GitHub: `--add-label` on edit.
 * GitLab: `add_labels` field on issue PUT (auto-creates missing labels).
 */
export function labelAddCmd(
  forge: ForgeType,
  target: "issue" | "mr",
  number: number,
  name: string,
): string {
  if (forge === "github") return `gh ${target} edit ${number} --add-label ${shq(name)}`;
  return `glab api -X PUT -f "add_labels=${shq(name)}" /projects/:id/${target === "issue" ? `issues/${number}` : `merge_requests/${number}`}`;
}

/** Remove a label from an issue. GitLab: `remove_labels` on issue PUT. */
export function labelRemoveCmd(
  forge: ForgeType,
  target: "issue" | "mr",
  number: number,
  name: string,
): string {
  if (forge === "github") return `gh ${target} edit ${number} --remove-label ${shq(name)}`;
  return `glab api -X PUT -f "remove_labels=${shq(name)}" /projects/:id/${target === "issue" ? `issues/${number}` : `merge_requests/${number}`}`;
}

// ── Repo settings ─────────────────────────────────────────────────────────

/**
 * Repo settings relevant to merge methods.
 *
 * GitHub: three independent booleans via GraphQL.
 * GitLab: a `merge_method` enum + a separate `squash_option` enum on the
 * project; the normalized booleans are DERIVED from them (see
 * `forge-mapping.ts: mapGlRepoSettings`).
 */
export function repoSettingsCmd(forge: ForgeType): string {
  if (forge === "github") {
    return "gh repo view --json nameWithOwner,url,defaultBranchRef,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed";
  }
  return "glab api /projects/:id --output json";
}

// ── CI run fetch ──────────────────────────────────────────────────────────────

/** One CI-run fetch (the ciWatch loop body + the direct ciRun call). */
export function ciRunOnce(
  execFn: (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  forge: ForgeType,
  cwd: string,
  owner: string,
  repo: string,
  id: number,
): Promise<string> {
  const cmd =
    forge === "github" ? `gh api /repos/${owner}/${repo}/actions/runs/${id}` : pipelineViewCmd(id);
  return execFn(cmd, { cwd, maxBuffer: 512 * 1024 }).then(({ stdout }) => stdout);
}
