/**
 * forge-commands — pure command-string builders for the gh/glab adapter
 * (S2 of epic #608).
 *
 * Keeping the argv shaping here (instead of inline in the forge.ts methods)
 * lets the offline smoke tests assert the EXACT command string the
 * production path would execute — including the load-bearing invariants
 * (e.g. GitLab MR merge MUST carry `--auto-merge=false`).
 *
 * The pull-request / merge-request builders live in `forge-commands-pr.ts` and
 * are re-exported here, so the `cmds.*` call sites (and the argv-pinning tests)
 * keep one import surface for the whole builder set.
 */

import type { ForgeType } from "./forge-detect.ts";

export * from "./forge-commands-pr.ts";

/** Shell-quote a single argument (the command seam is a shell string). */
export function shq(arg: string): string {
  if (/^[A-Za-z0-9_@.\/:=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// ── Issues ────────────────────────────────────────────────────────────────

/**
 * The page size every `forge_read` LIST asks for (#2160 lens fix).
 *
 * `gh issue/pr list` answers 30 rows and `glab issue/mr list` one page of 20
 * unless told otherwise, and a short list is indistinguishable, in the bytes
 * the child reads, from the whole list — the child has nothing to compare the
 * row count against. So the parent asks for the page the CLI will carry and
 * `forge-read-execute.ts` discloses a reply that FILLS it. The cap is the
 * parent's, not a request field: a child that could raise it would be choosing
 * how much of its own context a read spends.
 */
export const FORGE_LIST_LIMIT = 100;

/** The page flag this forge's list subcommand takes (`--limit` / `--per-page`). */
export function forgeListPageFlag(forge: ForgeType): string {
  return forge === "github" ? `--limit ${FORGE_LIST_LIMIT}` : `--per-page ${FORGE_LIST_LIMIT}`;
}

export function issueViewCmd(forge: ForgeType, number: number): string {
  if (forge === "github")
    return `gh issue view ${number} --json number,title,body,state,url,author,labels,createdAt,updatedAt`;
  return `glab issue view ${number} --output json`;
}

/**
 * One label flag per label, each through `shq` — the same quoting the title
 * gets. A label name may contain a space and a `:` (`auto-filed`, `kind: bug`),
 * and this seam is a shell string, so an unquoted label would split into extra
 * argv elements (`--label kind :` `bug`) or worse. GitHub takes one `--label`
 * per label; GitLab's `glab issue create --label` takes a comma-separated list
 * (`--label a,b`), so a label containing a comma cannot be expressed there and
 * never reaches this builder: `normalizeLabels`' pattern excludes `,`.
 */
export function labelFlags(forge: ForgeType, labels: string[]): string {
  if (labels.length === 0) return "";
  if (forge === "github") return labels.map((l) => ` --label ${shq(l)}`).join("");
  return ` --label ${labels.map((l) => shq(l)).join(",")}`;
}

/**
 * `gh issue create` does NOT support `--json` (verified: `gh issue create
 * --help` — the flag list has no `--json`). On success gh prints the created
 * issue's URL as a single plain-text line to stdout. The mapper in `forge.ts`
 * (`issueCreate`) parses that line into a NormalizedIssue via
 * `parsePrNumberFromResponse` (which handles both `/issues/N` and
 * `/-/merge_requests/N` URL shapes, and also tolerates a JSON payload for
 * forward-compat with a `gh` release that adds `--json` to create).
 *
 * #1377: `labels` is optional and renders NOTHING when empty, so an existing
 * caller's argv is byte-for-byte the command it always ran.
 */
export function issueCreateCmd(
  forge: ForgeType,
  title: string,
  bodyFile: string,
  labels: string[] = [],
): string {
  const labelFlags_ = labelFlags(forge, labels);
  if (forge === "github")
    return `gh issue create --title ${shq(title)} --body-file ${shq(bodyFile)}${labelFlags_}`;
  // glab issue create takes the description as a literal string. The file
  // content is expanded by the caller (the forge object reads the file and
  // passes the content); the `-d` value here is the *expanded* content.
  return `glab issue create -t ${shq(title)} -d ${shq(`@${bodyFile}`)}${labelFlags_}`;
}

export function issueCommentCmd(forge: ForgeType, number: number, bodyFile: string): string {
  if (forge === "github") return `gh issue comment ${number} --body-file ${shq(bodyFile)}`;
  return `glab api --method POST --header "Content-Type: application/json" -f "body=@${bodyFile}" /projects/:id/issues/${number}/notes`;
}

/**
 * List an issue's comments. GitHub: `gh issue view N --json comments` (the
 * `comments` field is a `gh issue view` GraphQL field — each row carries
 * `id`, `body`, `html_url`, `created_at`). GitLab: the issue's `notes`
 * endpoint. Both are single unchained reads (#408 recovery-command rule —
 * the #775 in-process handoff fallback's idempotency check runs on this seam
 * and must not prompt the permission matcher).
 */
export function issueCommentsCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh issue view ${number} --json comments`;
  return `glab api "/projects/:id/issues/${number}/notes" --output json`;
}

/**
 * List a PR/MR's review comments (the notes an agent posts via
 * `gh pr comment N --body-file` land here). GitHub: `gh pr view N
 * --json comments` — gh 2.98.0's GraphQL `PullRequest` type exposes exactly
 * the `comments` field, each row `{id, body, html_url, createdAt}` (the
 * `html_url` being the canonical `…#issuecomment-<id>` form). GitLab: the
 * MR's `notes` endpoint. #775 — the seam the in-process handoff fallback
 * needs to post the handoff comment on a PR-targeted cycle (the adapter
 * modeled `issueComment` only, so PR handoffs could never post in-process)
 * and to check for an existing handoff comment before re-posting (the
 * idempotency criterion).
 */
export function prCommentsCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr view ${number} --json comments`;
  return `glab api "/projects/:id/merge_requests/${number}/notes" --output json`;
}

/**
 * #775 — post a comment on a PR. GitHub: `gh pr comment` (same underlying
 * REST endpoint as `gh issue comment` — PRs are issues in GitHub's API).
 * GitLab: the MR's notes endpoint (same shape as `issueComment`).
 */
export function prCommentCmd(forge: ForgeType, number: number, bodyFile: string): string {
  if (forge === "github") return `gh pr comment ${number} --body-file ${shq(bodyFile)}`;
  return `glab api --method POST --header "Content-Type: application/json" -f "body=@${bodyFile}" /projects/:id/merge_requests/${number}/notes`;
}

export function issueSearchCmd(
  forge: ForgeType,
  query: string,
  opts: { allStates?: boolean } = {},
): string {
  if (forge === "github") {
    const state = opts.allStates ? " --state all" : "";
    return `gh issue list --search ${shq(query)}${state} ${forgeListPageFlag(forge)} --json number,title,state,url`;
  }
  const state = opts.allStates ? " --all" : "";
  return `glab issue list --search ${shq(query)}${state} ${forgeListPageFlag(forge)} --output json`;
}

/**
 * The repo's issue list with its state (#2160 — the `forge_read` `issue_list`
 * verb). Deliberately its own builder rather than a flag on `issueSearchCmd`:
 * a search and a listing are different questions, the CLI flags that spell
 * them differ (`--search` versus a bare `--state`), and a caller that wanted
 * both would get the wrong one from a shared builder.
 */
export function issueListCmd(forge: ForgeType, opts: { state?: string } = {}): string {
  const state = opts.state ? ` --state ${shq(opts.state)}` : "";
  if (forge === "github")
    return `gh issue list${state} ${forgeListPageFlag(forge)} --json number,title,state,url`;
  const all = opts.state === "all" ? " --all" : "";
  return `glab issue list${all} ${forgeListPageFlag(forge)} --output json`;
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

// ── CI runs ───────────────────────────────────────────────────────────────

/**
 * The page size and the three read builders the GitLab arm of the
 * merge-evidence gate issues now live in `forge-commands-gl-evidence.ts` (#2226,
 * §12 size cap): they exist only for that arm, so they sit beside the module
 * that grades their answers rather than in the forge-wide table below.
 */

/**
 * A CI run/pipeline id: a positive integer, or a refusal that names the id.
 *
 * The id reaches a shell string, so it is checked rather than coerced. A builder
 * that accepted `-1`, `1.5` or `NaN` would interpolate whatever it was handed —
 * every other target in this file goes through a validator or `shq` for the same
 * reason, and a numeric argument is not exempt because it is typed `number` at
 * the call site: the value arrives from a request the child composed.
 */
function ciId(id: number, what: string): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(`forge ci: ${what} must be a positive integer (got ${String(id)})`);
  }
  return id;
}

/** Watch a GitHub Actions run (the CLI does the polling). */
export function ciWatchCmd(runId: number): string {
  return `gh run watch ${ciId(runId, "run id")}`;
}

/**
 * Fetch one GitLab pipeline by id (the GitLab watch is a 30s polling loop;
 * this is one iteration of it). `:id` is the *project* id — glab expands it.
 */
export function pipelineViewCmd(pipelineId: number): string {
  return `glab api /projects/:id/pipelines/${ciId(pipelineId, "pipeline id")} --output json`;
}

/** List the project's pipelines (newest first) — the watch's entry point. */
export function pipelineListCmd(limit = 1): string {
  return `glab api "/projects/:id/pipelines?per_page=${limit}" --output json`;
}

// ── Labels ────────────────────────────────────────────────────────────────

/**
 * #1377 — list the repo's label NAMES, the read behind `Forge.labelList`.
 *
 * `gh label list --limit 1000 --json name`. `--limit` is the only page knob gh
 * gives this subcommand (no `--all`, no `--page` — verified against
 * `gh label list --help` on 2.102.0), so the read asks for the largest page the
 * CLI will carry. The caller caps a filing at 5 labels, so a page this size is
 * comfortably the whole set for any real repo — but "comfortably" is not a
 * guarantee, so `GH_LABEL_LIST_LIMIT` is exported and `labelListPageLimit()`
 * answers the number the plan layer compares the row count against: a read that
 * lands EXACTLY on the page size is treated as possibly truncated and halts the
 * filing rather than reporting a label missing. A misread here is not cosmetic —
 * "that label does not exist" refuses legitimate work, and the driver never
 * creates the label to fix it.
 *
 * GitLab: `glab label list --page 1 --per-page 1000 --output json`. glab has no
 * `--all` (verified against the `glab-label-list(1)` man page: the flag list is
 * `-g/--group`, `-F/--output`, `-p/--page`, `-P/--per-page`), so the same
 * largest-page + completeness-signal shape applies. `--page 1` is explicit
 * rather than left to the default so the read is visibly one page of a known
 * size, and `GL_LABEL_LIST_PER_PAGE` is the GitLab page number.
 *
 * Both are single unchained reads (#408 recovery-command rule) so the
 * pre-filing check never re-prompts the permission matcher.
 */
export const GH_LABEL_LIST_LIMIT = 1000;
export const GL_LABEL_LIST_PER_PAGE = 1000;

/** The page size a `labelListCmd` read asks for, on this forge. */
export function labelListPageLimit(forge: ForgeType): number {
  return forge === "github" ? GH_LABEL_LIST_LIMIT : GL_LABEL_LIST_PER_PAGE;
}

export function labelListCmd(forge: ForgeType): string {
  if (forge === "github") return `gh label list --limit ${GH_LABEL_LIST_LIMIT} --json name`;
  return `glab label list --page 1 --per-page ${GL_LABEL_LIST_PER_PAGE} --output json`;
}

/** Create a label (GitLab auto-creates missing labels on add, but explicit create is the normalized path). */
export function labelCreateCmd(forge: ForgeType, name: string, color: string): string {
  if (forge === "github") return `gh label create ${shq(name)} --color ${shq(color)} --force`;
  return `glab api -X POST -f "name=${shq(name)}" -f "color=%23${shq(color)}" /projects/:id/labels`;
}

/**
 * The gh object-type keyword for a normalized `issue` / `mr` target. GitHub
 * has no `mr` subcommand — merge requests are pull requests (`gh pr edit`).
 * GitLab's `glab api` paths already use `merge_requests/` directly, so the
 * mapping is applied on the github branch only.
 */
function ghObjectType(target: "issue" | "mr"): "issue" | "pr" {
  return target === "issue" ? "issue" : "pr";
}

/**
 * Add a label to an issue/PR. GitHub: `--add-label` on edit (gh has no
 * `mr` subcommand — an `mr` target maps to `pr`, #775). GitLab:
 * `add_labels` field on issue/MR PUT (auto-creates missing labels).
 */
export function labelAddCmd(
  forge: ForgeType,
  target: "issue" | "mr",
  number: number,
  name: string,
): string {
  if (forge === "github")
    return `gh ${ghObjectType(target)} edit ${number} --add-label ${shq(name)}`;
  return `glab api -X PUT -f "add_labels=${shq(name)}" /projects/:id/${target === "issue" ? `issues/${number}` : `merge_requests/${number}`}`;
}

/** Remove a label from an issue/PR. Same github `mr`→`pr` mapping as `labelAddCmd` (#775). */
export function labelRemoveCmd(
  forge: ForgeType,
  target: "issue" | "mr",
  number: number,
  name: string,
): string {
  if (forge === "github")
    return `gh ${ghObjectType(target)} edit ${number} --remove-label ${shq(name)}`;
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

// ── CI run logs (#2160) ────────────────────────────────────────────────────

/**
 * The jobs of one CI run / pipeline — the read that decides WHICH log to ask
 * for. GitHub: the Actions API's jobs endpoint (snake_case rows). GitLab: the
 * pipeline's jobs (`glab api` expands `:id`, so the command is forge-native).
 */
export function ciRunJobsCmd(forge: ForgeType, owner: string, repo: string, id: number): string {
  // `owner`/`repo` come from the parsed remote URL, which is data the parent
  // does not author — every other builder in this file quotes its data through
  // `shq` for the same reason, and a path segment carrying a shell metacharacter
  // would otherwise reach the exec string unquoted. The run id is checked rather
  // than quoted: it is a number in the signature, and a value that is not a
  // positive integer is a caller error, not something to route to the CLI.
  const runId = ciId(id, "run id");
  if (forge === "github")
    return `gh api /repos/${shq(owner)}/${shq(repo)}/actions/runs/${runId}/jobs --paginate`;
  return `glab api /projects/:id/pipelines/${runId}/jobs --output json`;
}

/**
 * The failed-job log text. GitHub: `gh run view --log-failed`, which answers
 * the concatenated log of every failed job of the run. GitLab has no such
 * whole-run form, so the caller asks per job with `ciJobTraceCmd`. Neither arm
 * takes a repo slug — the run/pipeline id is globally addressable, so there is
 * no `owner` parameter here to keep in step with the caller.
 */
export function ciRunLogCmd(forge: ForgeType, id: number): string {
  const runId = ciId(id, "run id");
  if (forge === "github") return `gh run view ${runId} --log-failed`;
  return `glab ci trace ${runId}`;
}

/** One GitLab job's trace — the per-job arm of the GitLab failed-log read. */
export function ciJobTraceCmd(jobId: number): string {
  return `glab api /projects/:id/jobs/${ciId(jobId, "job id")}/trace --output json`;
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
  // The same id rule as `ciRunJobsCmd`, and the same reason: this seam is a
  // shell string and the id arrives from a caller outside this file.
  const runId = ciId(id, "run id");
  const cmd =
    forge === "github"
      ? `gh api /repos/${shq(owner)}/${shq(repo)}/actions/runs/${runId}`
      : pipelineViewCmd(runId);
  return execFn(cmd, { cwd, maxBuffer: 512 * 1024 }).then(({ stdout }) => stdout);
}
