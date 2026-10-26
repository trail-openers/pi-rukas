/**
 * headless-s5-head — the #1533 head-verification rows of the headless S5
 * fixture's exec seam, split out of headless-s5-fixture.ts (AGENTS.md §12).
 *
 * The S5 fixture repos are throwaway directories with no remote. The merged
 * step's head verification reads the refs a remote would hold — it fetches
 * `<remote> <branch> <mainline>`, resolves `origin/<branch>`, and computes two
 * merge-base patch identities over `origin/<mainline>` — so in this fixture every
 * one of those reads fails against the real git, and every merging case parks on
 * an unreadable mainline or an unresolvable ref. These branches answer them.
 *
 * THE FIXTURE ANSWERS, IT DOES NOT DECIDE. Each branch serves a fixed OID or an
 * empty diff, and the OIDs are chosen so the two sides of the identity comparison
 * are distinguishable: a ref naming the MAINLINE is the base half of an identity
 * and answers with `EVIDENCE_BASE`, while `origin/<branch>` answers with the head
 * the case named. Nothing here picks a verdict — the seam's silence is still the
 * `unexpected` bucket, and an unexpected read still fails the harness's clean-log
 * assertion, which is what keeps the fixture honest about what a cycle really
 * asked for.
 *
 * Two forms reach this seam. argv-form calls arrive through the dispatch at the
 * top of `mergeExec`; the string-form calls arrive here because the identity and
 * mainline helpers build them as shell strings, and an argv matcher never sees
 * them. A read that lands in neither branch is a fixture gap, not a cycle bug.
 */

import { EVIDENCE_BASE, EVIDENCE_HEAD, FIXTURE_PATCH_ID } from "./headless-s5-forge.ts";
import type { MergeExecLog } from "./headless-s5-fixture.ts";

/** The argv-form head-verification reads: which subcommand the seam answers, and with what. */
export function headGitArgvAnswer(
  argv: string[],
  log: MergeExecLog,
  heads: { fetchedHead: string },
): { stdout: string } | undefined {
  const line = ["git", ...argv].join(" ");
  const sub = argv[0] ?? "";
  if (sub === "merge-base") {
    // The identity's merge base, over refs this remote-less clone cannot
    // resolve. Answered with a fixed OID so the patch identity is computed (and
    // compared) rather than the check refusing an unreadable base; the
    // comparison itself is what the case under test asserts on.
    log.headReads.push(line);
    return { stdout: `${EVIDENCE_HEAD}\n` };
  }
  if (sub === "check-ref-format") {
    // The branch-name guard for the head read. These fixture repos do not have
    // the cycle's branch at all, so the real git refused it and the merged step
    // parked. Answered as valid; the identity comparison is what the cases
    // assert on, not whether the local branch exists.
    log.headReads.push(line);
    return { stdout: "" };
  }
  if (sub === "diff") {
    log.headReads.push(line);
    return { stdout: "" };
  }
  // The merged step fetches the head and the mainline before it trusts any
  // identity, and these throwaway repos have no remote at all. A cycle that
  // reached this fetch with a real remote would have had one in `git remote`,
  // and the check refuses that case instead.
  if (sub === "fetch") {
    log.headFetches.push(line);
    return { stdout: "" };
  }
  if (sub === "rev-parse" && argv.some((w) => w.startsWith("origin/"))) {
    // The head the check weighs, and the base it weighs it against. Both name
    // `origin/<ref>`s this clone cannot resolve, so the seam answers them
    // directly; every other rev-parse still runs against the fixture's real
    // repo, so an unexpected read stays unexpected. A ref naming the MAINLINE is
    // the base side of an identity, not the head: it answers with the base SHA,
    // so the two sides of a comparison are distinguishable.
    log.headReads.push(line);
    const target = argv.find((w) => w.startsWith("origin/")) ?? "";
    return { stdout: `${target.endsWith("/main") ? EVIDENCE_BASE : heads.fetchedHead}\n` };
  }
  // `readyPatchId` resolves the branch tip through `resolveHeadSha`, which
  // prefixes `-C <cwd>` and therefore is not the `rev-parse` subcommand at
  // argv[0]. Same reasoning: an `origin/<branch>` ref this fixture cannot
  // resolve, answered with the OID the evidence probe reported.
  if (sub === "-C" && argv[2] === "rev-parse" && argv.some((w) => w.startsWith("origin/"))) {
    log.headReads.push(line);
    return { stdout: `${EVIDENCE_HEAD}\n` };
  }
  return undefined;
}

/** The string-form head-verification reads (the identity and mainline helpers). */
export function headGitStringAnswer(
  line: string,
  log: MergeExecLog,
  patchId = FIXTURE_PATCH_ID,
): { stdout: string } | undefined {
  // The identity's merge base and its patch id both name `origin/<ref>`s these
  // repos cannot resolve, and both arrive as STRING-form calls, so the argv
  // matcher never sees them and they would land in `unexpected`. The OID is fixed
  // and the patch id is the case's own, so the identity comparison the cases
  // assert on runs against the values the case chose.
  if (line.startsWith("git merge-base ") && line.includes("origin/")) {
    log.headReads.push(line);
    return { stdout: `${EVIDENCE_HEAD}\n` };
  }
  if (line.includes("git patch-id")) {
    log.headReads.push(line);
    return { stdout: `${patchId} commit\n` };
  }
  return undefined;
}
