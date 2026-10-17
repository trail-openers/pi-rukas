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
    return `gh pr view ${number} --json number,title,body,state,url,headRefName,baseRefName,author,mergeable,mergeStateStatus,isDraft,labels,createdAt,updatedAt`;
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
  opts: { baseBranch?: string; draft?: boolean } = {},
): string {
  // #1292 — both CLIs spell it `--draft`; a draft is still state OPEN/opened.
  const draftFlag = opts.draft ? " --draft" : "";
  const baseBranch = opts.baseBranch;
  if (forge === "github") {
    const head = baseBranch ? `${shq(baseBranch)}...${shq(headBranch)}` : shq(headBranch);
    return `gh pr create --title ${shq(title)} --head ${head} --body-file ${shq(bodyFile)}${draftFlag}`;
  }
  // GitLab: NO --head flag — the source branch is positional, and the
  // target is `--target-branch`.
  const target = baseBranch ? ` --target-branch ${shq(baseBranch)}` : "";
  return `glab mr create ${shq(headBranch)} -t ${shq(title)} --description-file ${shq(bodyFile)}${target}${draftFlag} --output json`;
}

/**
 * #1292 — mark a draft PR/MR ready for review. `gh pr ready` on a PR that is
 * already ready warns and exits 0, as does `glab mr update --ready` on an MR
 * without the draft marker, so a repeat is harmless.
 */
export function prReadyCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr ready ${number}`;
  return `glab mr update ${number} --ready`;
}

/**
 * #1398 — the inverse: put a PR/MR back to draft. Verified against the
 * installed CLIs and their docs, and recorded in the PR body:
 *
 *  - GitHub `gh pr ready <N> --undo` (gh 2.102.0 `--help`: "--undo Convert a
 *    pull request to \"draft\""). On an unknown PR it exits 1 with
 *    `GraphQL: Could not resolve to a PullRequest with the number of …` — it
 *    does NOT exit 0 silently, which is why the re-arm can tell a real
 *    success from a no-op (the ready direction cannot: it warns and exits 0).
 *  - GitLab `glab mr update <N> --draft` (docs/source/mr/update.md: "--draft
 *    Mark merge request as a draft", with `--wip` as the documented
 *    alternative). `glab` is not installed in the sandbox image's dev host, so
 *    this form is pinned from the upstream docs rather than a local `--help`.
 *
 * Deliberately NOT a bare extra `prReadyCmd` call: a `gh pr ready` that
 * "succeeds" on an already-ready PR leaves it mergeable and reports nothing,
 * so the re-arm must issue the draft direction and read the forge back.
 */
export function prDraftCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr ready ${number} --undo`;
  return `glab mr update ${number} --draft`;
}

/**
 * MR/PR merge. SAFETY INVARIANT (epic #608): on GitLab this MUST always
 * pass `--auto-merge=false`. `glab mr merge` enables scheduled auto-merge
 * when auto-merge is configured for the MR, deferring the actual merge to a
 * GitLab pipeline trigger — the driver would then record "merged" for a MR
 * that has not merged. `--auto-merge=false` forces the immediate, explicit
 * merge. There is no GitHub analogue (gh pr merge merges immediately).
 */
/**
 * `--subject` must be a non-empty string: `gh pr merge` has no way to
 * express "use the repository default" (an empty value would become
 * `--subject ''`, which GitHub rejects or treats as a blank subject), so
 * the flag is absent exactly when no subject was provided. The subject
 * must not contain a newline (a shell one-liner argument); callers clip.
 */
export function prMergeSubjectFlag(subject: string | undefined): string {
  const s = subject?.trim();
  if (!s) return "";
  return ` --subject ${shq(s)}`;
}

export function prMergeCmd(
  forge: ForgeType,
  number: number,
  method: "squash" | "merge" | "rebase" = "squash",
  subject?: string,
): string {
  const subjectFlag = prMergeSubjectFlag(subject);
  if (forge === "github") return `gh pr merge ${number} --${method} --delete-branch${subjectFlag}`;
  return `glab mr merge ${number} --${method} --auto-merge=false${subjectFlag}`;
}

export function prDiffCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr diff ${number}`;
  return `glab mr diff ${number}`;
}

/**
 * CI checks for a PR/MR.
 *
 * GitHub: `gh pr checks` exits non-zero when any check fails — callers must
 * tolerate that (the existing driver does). The requested fields are pinned
 * to gh 2.98.0 by `smoke-tests/test-gh-argv.ts`; `isRequired` must not be
 * added back — it is not a field this subcommand supports, and requesting it
 * made the whole invocation fail closed on every PR (#745). GitLab:
 * `glab ci lint` is static analysis and NOT run-level checks, so we go
 * through the API: the MR's open pipeline's jobs, via `glab api` against
 * `/projects/:id/merge_requests/:iid/pipelines` (first entry = most recent).
 */
export function prChecksCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr checks ${number} --json name,state,bucket`;
  return `glab api "/projects/:id/merge_requests/${number}/pipelines" --output json`;
}

/**
 * GitHub's authoritative merge verdict for the merge-evidence gate. The
 * driver used to hard-code this field list inline; it lives here so the
 * argv-pinning test (`test-gh-argv.ts`) covers it the same way it covers
 * `prChecksCmd`.
 */
export function mergeEvidenceViewCmd(number: number): string {
  return `gh pr view ${number} --json mergeStateStatus,mergeable,state`;
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
