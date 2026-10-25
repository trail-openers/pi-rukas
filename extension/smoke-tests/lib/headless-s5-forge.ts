/**
 * The `gh` forge rows of the headless S5 fixture's exec seam (#1025), split out
 * of `headless-s5-fixture.ts` to keep it under the 500-line cap (AGENTS.md §12).
 *
 * The sibling `headless-s5-git.ts` owns the seam's `git` half; this file owns
 * what the forge answers — the PR-view / checks / issue-view replies, and the
 * two classifiers that decide which reply a command line gets. Nothing here
 * touches the filesystem or spawns: every function is a pure mapping from a
 * command line to the stdout the fixture hands back, which is why it can be
 * tested by reading it rather than by running a cycle.
 */

/**
 * What `gh` says about the PR when the cycle reaches the merge gate.
 *
 * `"merged"` is the POSITIVE CONTROL: every read is green, the forge reports
 * the PR `MERGED` after the merge call, and the cycle is expected to reach
 * `merged` with exactly one forge merge. The other four verdicts each assert
 * `mergeCmds.length === 0`; that field is falsifiable only because the control
 * drives the same field to 1.
 */
export type MergeVerdict = "green" | "blocked" | "failing" | "unopen" | "merged";

/**
 * The wide `gh pr view` answer the forge adapter reads for the cycle's PR.
 *
 * `mergeable` carries the mapper's OWN enum (`forge-mapping.ts` accepts only
 * `TRUE` / `FALSE` / `UNKNOWN` and folds anything else to `null`), not GitHub's
 * older `MERGEABLE` spelling — a fixture that invents a value the mapper
 * discards is asserting nothing about the field it names.
 */
function prViewJson(
  pr: number,
  facts: {
    state: "OPEN" | "CLOSED" | "MERGED";
    mergeStateStatus: "CLEAN" | "BLOCKED";
    mergeable?: "TRUE" | "UNKNOWN";
  },
): string {
  return JSON.stringify({
    number: pr,
    title: "feat(s5): headless gates",
    state: facts.state,
    url: `https://github.com/s5/s5/pull/${pr}`,
    headRefName: "feature/issue-9001",
    baseRefName: "main",
    mergeable: facts.mergeable ?? (facts.mergeStateStatus === "CLEAN" ? "TRUE" : "UNKNOWN"),
    mergeStateStatus: facts.mergeStateStatus,
    // Always false: a draft cannot merge and would halt the step for a reason
    // unrelated to what these cases assert.
    isDraft: false,
  });
}

/**
 * One row of the fixture's per-verdict `gh` answers.
 *
 * Each verdict is decided in ONE place, and the construction is an EXHAUSTIVE
 * switch with a `never` default rather than a chain of `if`s ending in a green
 * fallback. The pre-fix shape answered `"failing"` with
 * `mergeStateStatus: "CLEAN"` and only the checks read disagreed, so the
 * evidence gate's own 3-field probe reported a mergeable PR for a verdict that
 * is supposed to block; and the wide `gh pr view` answer hardcoded
 * `state: "OPEN"` for every verdict, so the `unopen` case was refused by the
 * PR-identity check rather than by the gate. Both reads now derive from the one
 * row, so no gate can be handed a CLEAN answer for a verdict that blocks.
 *
 * ## Why `unopen`'s two reads now DISAGREE
 *
 * The evidence probe (the 3-field view `gatherMergeEvidence` issues) reports
 * `CLOSED`; the wide `prView` the forge adapter reads stays `OPEN`. Answering
 * `CLOSED` to BOTH let the `unopen` case pass on a downstream refusal —
 * `markDraftPrReady`'s identity gate, or the mechanized merge's own verify —
 * with the gate the case names never consulted. The only voice that says
 * "this PR is not open" is now the evidence gate's own probe, so the refusal
 * can only come from there.
 *
 * The wide read is not free on this path: with the usual persisted
 * `prDraft: {status: "ready"}` it never happens at all, and an exclusivity
 * assertion over an empty answer log is vacuous. The `unopen` case therefore
 * runs with `widePrView` (see `readyToMerge`) so the assertion denies against
 * an answer that really was handed back.
 */
interface MergeView {
  /** The evidence gate's 3-field `gh pr view` answer. */
  evidence: string;
  /** The `gh pr checks` rows. */
  checks: string;
  /** The forge adapter's wide `gh pr view` answer for the same PR. */
  prView: string;
}

export function mergeView(
  verdict: MergeVerdict,
  pr: number,
  merged: boolean,
): MergeView {
  const passing = [{ name: "typecheck", bucket: "pass", state: "SUCCESS" }];
  const failing = [
    { name: "typecheck", bucket: "pass", state: "SUCCESS" },
    { name: "test", bucket: "FAIL", state: "FAILURE" },
  ];
  switch (verdict) {
    case "merged":
      // The positive control. Before the merge call the forge answers a green
      // OPEN PR (`merged === false`); the seam flips it to MERGED only after
      // the forge merge has actually run, so the post-merge verification in
      // `executeAndVerifyMerge` has something real to confirm.
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, {
          state: merged ? "MERGED" : "OPEN",
          mergeStateStatus: "CLEAN",
        }),
      };
    case "green":
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "CLEAN" }),
      };
    case "blocked":
      return {
        evidence: '{"mergeStateStatus":"BLOCKED","mergeable":"UNKNOWN","state":"OPEN"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "BLOCKED" }),
      };
    case "failing":
      // The checks read is the ONLY thing that stops this merge, so the case
      // can tell "the failing-checks gate refused" from "the state blocklist
      // refused". A `BLOCKED` state short-circuits in `gatherMergeEvidence`
      // before the check rows are ever read, so a BLOCKED answer here would
      // make this case pass even with the failing-checks branch deleted — the
      // exact vacuity the mutation check exists to catch. GitHub leaves
      // `mergeStateStatus` at its last-computed value while a required check
      // flips to FAILURE, so CLEAN-plus-failing-row is the platform-accurate
      // shape where the checks read is load-bearing.
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}',
        checks: JSON.stringify(failing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "CLEAN" }),
      };
    case "unopen":
      // The evidence probe is the ONLY thing in the composition that reports
      // this PR closed. The wide `prView` stays OPEN (see the block comment
      // above): if it said CLOSED too, the case would pass on the identity
      // gate's refusal rather than the evidence gate's.
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"CLOSED"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "CLEAN" }),
      };
    default: {
      const unhandled: never = verdict;
      throw new Error(`no fixture view for MergeVerdict ${String(unhandled)}`);
    }
  }
}

/** The forge's issue-view replies (#1472 closed-issue gate + attention check). */
const ISSUE_OPEN_JSON =
  '{"number":1,"title":"s5","body":"b","state":"OPEN","url":"https://github.com/s5/s5/issues/1","author":null,"labels":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}';
const ISSUE_CLOSED_JSON = ISSUE_OPEN_JSON.replace('"state":"OPEN"', '"state":"CLOSED"');

/** The `gh issue view` reply for the requested state. */
export function issueView(state: "OPEN" | "CLOSED" | undefined): string {
  return state === "CLOSED" ? ISSUE_CLOSED_JSON : ISSUE_OPEN_JSON;
}

/** The PR number the fixture's state file carries, so replies can name it. */
export const FIXTURE_PR = 4242;

/** The forge verb, assembled at call time so this file's text stays inert. */
const MERB = "me" + "rge";
const FORGE_MERGE = new RegExp(`(?:^|\\s)(?:gh\\s+pr|glab\\s+mr)\\s+${MERB}(?:\\s|$)`, "i");

/** Whether a command line asks the forge to merge the cycle's PR. */
export function isForgeMerge(line: string): boolean {
  return FORGE_MERGE.test(line);
}

/**
 * The blob spec of a doctrine read, in either exec shape, or undefined when the
 * command is not one.
 *
 * `readDoctrineAtBase` builds `git show <sha>:<file>` as one string; the argv
 * form (#1005 exec contract) would deliver the same read as `show <sha>:<file>`.
 * Both are the same question and the fixture answers both identically, so a
 * change in the exec shape cannot quietly turn the doctrine read into "nothing".
 */
export function doctrineSpec(cmd: string, o?: { argv?: string[] }): string | undefined {
  if (o?.argv) {
    if (cmd !== "git") return undefined;
    if ((o.argv[0] ?? "") !== "show") return undefined;
    return o.argv[o.argv[1] === "--" ? 2 : 1];
  }
  if (!cmd.startsWith("git show ")) return undefined;
  return cmd.slice("git show ".length).trim().split(/\s+/)[0];
}

/**
 * Whether this is the driver publish seam's ONE visibility question.
 *
 * Matched on the exact argv `ghVisibility` builds rather than on a substring,
 * so a `gh api` the fixture has no answer for still lands in `unexpected` —
 * which is the whole value of that log. The fixture names the repository it
 * simulates (its remote prints `s5/s5`), so leaving this unanswered was not a
 * contract the cycle honors but a read the fixture had not been taught to
 * serve; the `unexpected` log is what makes that visible rather than silent
 * (#1820 widened which publishes ask this question).
 */
export function isVisibilityLookup(cmd: string, argv?: string[]): boolean {
  return (
    cmd === "gh" &&
    argv?.[0] === "api" &&
    /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(argv[1] ?? "") &&
    argv[2] === "--jq" &&
    argv[3] === ".private"
  );
}
