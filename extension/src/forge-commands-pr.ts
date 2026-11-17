/**
 * forge-commands-pr — the pure pull-request / merge-request command builders
 * (S2 of epic #608), split out of `forge-commands.ts` along the natural seam
 * the file already had (AGENTS.md §12: split, never compress).
 *
 * Same contract as its sibling module: argv shaping lives here so the offline
 * smoke tests assert the EXACT command string the production path would
 * execute — including the load-bearing invariants (e.g. GitLab MR merge MUST
 * carry `--auto-merge=false`, and every merge MUST carry a head pin).
 */

import { forgeListPageFlag, shq } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { glabMrCreateArgvEnabled } from "./gl-mr-create-switch.ts";
import { isFullCommitSha } from "./review-head-sha.ts";

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
  if (forge === "github") {
    const stateFlag = opts.state ? ` --state ${shq(opts.state)}` : "";
    const head = opts.sourceBranch ? ` --head ${shq(opts.sourceBranch)}` : "";
    return `gh pr list${stateFlag}${head} ${forgeListPageFlag(forge)} --json number,title,state,url,headRefName,baseRefName,labels`;
  }
  // `glab mr list` has NO `--state`: its help offers `-c/--closed` and
  // `-M/--merged` instead, and `-M` implies closed. So "open" — the only state any
  // caller here asks for — is glab's own default and needs no flag; asking for
  // `--state open` was an invented flag that made every MR lookup die on
  // `ERROR Unknown flag:`. Any other state has no spelling this builder can emit,
  // so it is refused by name rather than silently answered as the default — a
  // caller that asked for merged MRs and got the open ones would be reading a
  // wrong answer from a command that exited 0.
  if (opts.state && opts.state !== "open") {
    throw new Error(
      `forge pr list: glab mr list has no --state; it selects with -c/--closed and -M/--merged (asked for state "${opts.state}")`,
    );
  }
  const source = opts.sourceBranch ? ` --source-branch ${shq(opts.sourceBranch)}` : "";
  return `glab mr list${source} ${forgeListPageFlag(forge)} --output json`;
}

/**
 * The open-PR lookup the classic driver's pre-merge gates issue OUTSIDE the
 * adapter: `gh pr list --state open` carrying the `body` field, which
 * `prListCmd` does not request and `matchPrForIssue` reads.
 *
 * GitHub-only by construction. GitLab's `glab mr list` carries no body field
 * at all (its rows are the mapper's, and none of them is a description), so a
 * GitLab cycle asking this question would read an empty body for every MR and
 * decide "no PR matches" — a wrong answer from a command that exited 0. The
 * caller refuses with this string instead of issuing it. `state` is the caller
 * to supply (`--state` is how gh selects open PRs; an absent state is not
 * "open"). GitLab's `glab mr list` is doubly unable to answer it: no `--state`
 * and no body field, which is why the GitLab caller refuses before building.
 */
export function openPrBodyListCmd(state: string): string {
  return `gh pr list --state ${shq(state)} --limit 100 --json number,headRefName,body`;
}

/**
 * A forge command, in one of the two shapes the executor takes: a shell string
 * (every builder but one) or argv (`glab mr create`, below). The union is what
 * keeps the exception visible at every call site instead of a `string` that
 * silently drops the argv half.
 */
export interface ForgeArgvCmd {
  /** The executable when `argv` is given, the whole shell string otherwise. */
  cmd: string;
  argv?: string[];
}

/**
 * `gh pr create` does NOT support `--json` (verified: `gh pr create --help`
 * — no `--json` in the flag list, and the doc text explicitly states
 * "Upon success, the URL of the created pull request will be printed").
 * The mapper in `forge.ts` (`prCreate`) already handles the plain-text URL
 * shape via `parsePrNumberFromResponse` + `makeMinimalPr`; the trailing
 * `makeMinimalPr` fallback fills in `url` from the parsed value.
 *
 * GitLab is the one builder on the argv path, because its body cannot travel
 * as shell text: `glab mr create` has no file form for the description at the
 * versions GitLab users run (`--description-file` is newer), so the body goes
 * as ONE argv element of `-d`, and `execFile` never re-parses it. The flags are
 * the ones `glab mr create --help` lists: `-s/--source-branch` (the source is
 * never positional), `-t/--title`, `-d/--description`, `-b/--target-branch`,
 * `--draft`, and `-y`, which is what stops the submission prompt from waiting
 * on a stdin nobody will type into. There is no `--output json` — on success
 * the subcommand prints the MR's URL as plain text, which is the shape the
 * mapper reads. `smoke-tests/test-glab-flags.ts` judges every flag against the
 * subcommand's own `--help`.
 *
 * The `"0"` arm of `PI_ENSEMBLE_GLAB_MR_CREATE` returns the pre-fix shell string
 * verbatim — a known-broken baseline, kept only so a cycle can be compared
 * against it.
 */
export function prCreateCmd(
  forge: ForgeType,
  title: string,
  headBranch: string,
  /** The body string on the argv path; the path of a temp FILE elsewhere. */
  body: string,
  opts: { baseBranch?: string; draft?: boolean } = {},
): ForgeArgvCmd {
  // #1292 — both CLIs spell it `--draft`; a draft is still state OPEN/opened.
  const draftFlag = opts.draft ? " --draft" : "";
  const baseBranch = opts.baseBranch;
  if (forge === "github") {
    const head = baseBranch ? `${shq(baseBranch)}...${shq(headBranch)}` : shq(headBranch);
    return {
      cmd: `gh pr create --title ${shq(title)} --head ${head} --body-file ${shq(body)}${draftFlag}`,
    };
  }
  if (!glabMrCreateArgvEnabled()) {
    return {
      cmd: `glab mr create ${shq(headBranch)} -t ${shq(title)} --description-file ${shq(body)}${baseBranch ? ` --target-branch ${shq(baseBranch)}` : ""}${draftFlag} --output json`,
    };
  }
  const argv = ["mr", "create", "-s", headBranch, "-t", title, "-d", body];
  if (baseBranch) argv.push("-b", baseBranch);
  if (opts.draft) argv.push("--draft");
  // Pinned last and unconditionally: without it glab asks for confirmation and
  // the driver has no terminal to answer.
  argv.push("-y");
  return { cmd: "glab", argv };
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

/**
 * #1533 — the head pin, forge-conditional.
 *
 * An approval covers ONE commit. Without the pin the driver's merge acts on
 * whatever head the forge holds when the command runs, so a push landing after
 * the review and before the merge is merged unreviewed. GitHub takes
 * `--match-head-commit <oid>` (gh refuses when the PR head has moved);
 * GitLab's `glab mr merge` has no such flag and takes `--sha <oid>` instead.
 * The two spellings are deliberately named in the tests rather than silently
 * unified — a pin that only exists for one forge is not a pin.
 */
export function prMergeHeadPinFlag(forge: ForgeType, headOid: string): string {
  // Fail closed at the single place the pin is written: an OID that is not a
  // full 40-char SHA would be interpolated into a shell string as-is, and an
  // abbreviated or non-hex value is exactly the "I meant this commit" claim
  // the pin exists to make precisely.
  if (!isFullCommitSha(headOid)) {
    throw new Error("merge head pin: not a full 40-char commit SHA");
  }
  return forge === "github" ? ` --match-head-commit ${shq(headOid)}` : ` --sha ${shq(headOid)}`;
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
  // #1533 — the head OID to pin, REQUIRED and declared before the optional
  // `subject`: a required parameter may not follow an optional one, and this
  // ordering is what makes an unpinned merge a compile error rather than an
  // `undefined` that silently produces the old, unpinned command.
  headOid: string,
  method: "squash" | "merge" | "rebase" = "squash",
  subject?: string,
): string {
  const subjectFlag = prMergeSubjectFlag(subject);
  const pin = prMergeHeadPinFlag(forge, headOid);
  if (forge === "github")
    return `gh pr merge ${number} --${method} --delete-branch${subjectFlag}${pin}`;
  // `glab mr merge` has NO `--subject`: its help spells the commit message
  // `-m/--message` for a merge and `--squash-message` for a squash. Asking for a
  // squash subject on GitLab therefore has no spelling this builder can emit, and
  // is refused by name rather than dropped — a driver that composed a subject and
  // watched it vanish would report a merge commit message the forge never wrote.
  if (subjectFlag) {
    throw new Error(
      "forge pr merge: glab mr merge has no --subject (it takes -m/--message or --squash-message); refusing to drop the composed subject",
    );
  }
  return `glab mr merge ${number} --${method} --auto-merge=false${pin}`;
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
 *
 * `author` rides the SAME read as the merge-author allowlist check (#2181):
 * who opened the PR is judged at the moment the CI verdict is read, and a
 * second `gh pr view` would be a second moment in which the PR could be
 * reassigned. Verified against gh 2.102.0 (`author` is a field of that
 * subcommand; the guard's own identity read already requests it).
 */
export function mergeEvidenceViewCmd(number: number): string {
  // #1533 — `headRefOid` is requested HERE rather than in a second read: the
  // OID the merge is pinned to must be the OID the CI verdict was observed at,
  // and two reads of a moving PR are two moments, not one. Verified against
  // gh 2.102.0 (`gh pr view <n> --json …,headRefOid` returns it).
  return `gh pr view ${number} --json mergeStateStatus,mergeable,state,headRefOid,author`;
}

/**
 * The reviews of a PR / the approvals of an MR.
 *
 * GitHub: the GraphQL `reviews` field on `gh pr view`, which answers a single
 * object `{"reviews": [...]}`. GitLab: the MR's `approvals` endpoint — `glab`
 * has no review subcommand that returns JSON, so the API is the only read that
 * answers who approved. Both are single unchained reads (#408
 * recovery-command rule).
 */
export function prReviewsCmd(forge: ForgeType, number: number): string {
  if (forge === "github") return `gh pr view ${number} --json reviews`;
  return `glab api "/projects/:id/merge_requests/${number}/approvals" --output json`;
}
