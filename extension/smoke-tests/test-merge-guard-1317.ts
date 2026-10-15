#!/usr/bin/env bun
/**
 * #1317 — every merge-like command the guard cannot read is refused, never
 * read as "not a merge" or as the current branch's PR. One matcher-level
 * assertion per shape (analyseMergeCommand, the guard's single entry point),
 * and the refusal named through the REAL hook for the classes that must say
 * why. The backstop (merge-like.ts) is the systematic floor: the shapes below
 * the readers miss are caught by it, not by a per-shape rule.
 *
 * Covered, in the order the review listed them:
 *   1. an unparseable canonical reading (a heredoc body with an apostrophe)
 *   2. the repo selector read from another segment
 *   3. a single `&` separator hiding a second merge
 *   4. brace expansion past its bound
 *   5. ANSI-C escapes spelling the verb
 *   6. case … esac shapes
 *   A. a substitution glued to the command word (`$(true)gh pr merge 12`)
 *   B. an unreadable PR number (`$PR`) — never the current branch's PR
 *   backstop. merge-like text with no readable merge head is refused
 */

import { type MergeAnalysis, analyseMergeCommand } from "../src/merge-analyse.ts";
import {
  GOOD_ENTRIES,
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const show = (a: MergeAnalysis) => JSON.stringify(a);

/** `cmd` is a merge of PR `n` (and, when given, repo `repo`). */
function merges(cmd: string, n: number | undefined, repo?: string) {
  const a = analyseMergeCommand(cmd);
  const ok = a.kind === "merge" && a.prNumber === n && (repo === undefined || a.repo === repo);
  assert(ok, `merge #${n ?? "?"}${repo ? ` in ${repo}` : ""}: ${JSON.stringify(cmd)} → ${show(a)}`);
}

/** `cmd` is refused with kind `k`. */
function kind(cmd: string, k: MergeAnalysis["kind"]) {
  const a = analyseMergeCommand(cmd);
  assert(a.kind === k, `${k}: ${JSON.stringify(cmd)} → ${show(a)}`);
}

/** `cmd` is not a merge at all. */
function benign(cmd: string) {
  const a = analyseMergeCommand(cmd);
  assert(a.kind === "none", `benign: ${JSON.stringify(cmd)} → ${show(a)}`);
}

// ------------------------------------------------------------ 1. unparsed canonical reading
// An apostrophe inside a quoted heredoc body never closes for the canonical
// reading; the raw reading used to fall through to "not a merge".
kind("cat <<'EOF'\ndon't\nEOF\ngh pr merge 17", "unparsed");
kind("gh pr merge 17 \"unterminated", "unparsed");

// ------------------------------------------------------------ 2. repo selector from another segment
kind("gh -R a/b pr view 1; gh pr merge 17", "repos");
kind("gh -R a/b pr view 1 && gh pr merge 17 --repo c/d", "repos");
// The same repo on the other segment is not a conflict.
merges("gh -R a/b pr view 1 && gh pr merge 17 --repo a/b", 17, "a/b");

// ------------------------------------------------------------ 3. single `&` separator
kind("gh pr merge 17 & gh pr merge 5", "multiple");
kind("gh pr merge 17 &gh pr merge 5", "multiple");

// ------------------------------------------------------------ 4. brace expansion
// Past the expansion bound the words bash runs are unknown: refused.
const wide = Array.from({ length: 300 }, (_, i) => `x${i}`).join(",");
{
  const a = analyseMergeCommand(`gh pr m{${wide},erge} 17`);
  assert(a.kind === "unparsed", `brace past the bound (300 alternatives): ${show(a)}`);
}
// Within the bound: the words are enumerated, and a merge among them is read.
merges("{gh,pr,merge,17}", 17);
// `gh pr {merge,view} 17` is `gh pr merge view 17` — a second positional, refused.
kind("gh pr {merge,view} 17", "unreadable");

// ------------------------------------------------------------ 5. ANSI-C escapes
merges("gh pr $'\\x6derge' 17", 17);
merges("gh pr $'\\155erge' 17", 17);
merges("gh pr $'\\u006derge' 17", 17);

// ------------------------------------------------------------ 6. case … esac
merges("case x in a) true;; esac; gh pr merge 17", 17);
merges("case x in a) gh pr merge 17", 17);
merges("case x in a) true;; b) gh pr merge 5 ;; esac", 5);

// ------------------------------------------------------------ A. glued substitution
merges("$(true)gh pr merge 12", 12);
merges("`true`gh pr merge 4", 4);
merges("$(echo)gh pr merge 17", 17);
merges("$(echo x)gh pr merge 9", 9);
// Shapes the split does not cover (a QUOTED command word glued to the
// substitution) fall to the backstop: merge-like, no readable head.
kind('$(true)"gh" pr merge 12', "unrecognised");

// ------------------------------------------------------------ B. unreadable PR number
kind("gh pr merge $PR", "unreadable");
kind('gh pr merge "$N"', "unreadable");
kind("gh pr merge 1 $X", "unreadable");
// The number after `-s` (`--squash`, a bare flag for gh) is a positional.
merges("gh pr merge -s 17", 17);
merges("gh pr merge 17 >/dev/null", 17);
merges("gh pr merge 17 --subject \"fix: a b\" 2>&1 &", 17);
// `17>` is fd 17 to bash: no PR argument, so the head resolves from the branch
// (the PR gh itself would merge). Read, not refused.
{
  const a = analyseMergeCommand("gh pr merge 17>/dev/null");
  assert(a.kind === "merge" && a.prNumber === undefined, `fd prefix is not a number: ${show(a)}`);
}
// REST paths without a leading slash, and a REST merge with no number.
merges("gh api pulls/17/merge -X PUT", 17);
merges("gh api repos/o/r/pulls/17/merge -X PUT", 17, undefined);
kind("gh api pulls/merge -X PUT", "unreadable");

// ------------------------------------------------------------ backstop
// Merge-like text with no readable merge head is refused, named.
kind('gh pr comment 5 --body "please merge"', "unrecognised");
// Inert shapes stay allowed.
benign("gh pr comment 5 --body-file x.md");
benign("gh pr view 17");
benign("git merge --ff-only origin/main");
benign("gh pr checks 17");
benign('echo "gh pr merge 12"');
benign('git commit -m "docs: explain gh pr merge 12"');
benign("gh pr view 17 --json mergeable,mergeStateStatus");
// `bash -c WORD` runs `gh` with the merge words as its own $0…: the old
// exemption let it through. It is refused now (over-refusal, not bypass).
kind("bash -c gh pr merge 17", "unrecognised");

// ------------------------------------------------------------ review: exemptions are provably inert only
// echo / printf output piped or redirected into an interpreter runs the merge.
kind('echo "gh pr merge 12" | sh', "unrecognised");
kind("printf 'gh pr merge 12' | bash", "unrecognised");
kind("echo gh pr merge 12 > x.sh; sh x.sh", "unrecognised");
// A substitution anywhere in the command: nothing is exempt, the merge is refused.
kind("echo $(\\gh pr merge 12)", "unrecognised");
kind("printf '%s' $(g\"h\" pr merge 12)", "unrecognised");
kind("git commit -m x $(\\gh pr merge 12)", "unrecognised");
kind("bash -c gh $(\\gh pr merge 12)", "unrecognised");
// Interpreters fed by here-strings / here-docs / process substitution.
kind('bash <<< "gh pr merge 12"', "unrecognised");
kind("sh <<EOF\ngh pr merge 12\nEOF", "merge");
kind("source <(echo gh pr merge 12)", "unrecognised");
kind("echo gh pr merge 12 | xargs -0 sh -c", "unrecognised");
// The xargs indirection the docs called out of scope: refused, never "not a merge".
kind("echo 17 | xargs -I{} gh pr merge {}", "unrecognised");
// The alias indirection: the verb lives inside a quoted definition, refused.
kind("alias m='gh pr merge'; m 17", "unrecognised");
// Still allowed: the exemption applies where nothing executes the text.
benign('echo "gh pr merge 12"');
benign('git commit -m "fix: refuse gh pr merge shapes"');
benign("gh pr view 17");
benign("gh pr comment 5 --body-file x.md");
benign("git merge --ff-only origin/main");
benign("gh api --method GET repos/o/r/pulls/17/merge");
benign("gh api -XGET repos/o/r/pulls/17/merge");

// ------------------------------------------------------------ review A: value flags per forge
// `-m` is --merge (bare) for gh: the number after it is the PR.
merges("gh pr merge -m 17", 17);
// `-m` takes the message for glab: the number after the message is the MR.
merges('glab mr merge -m "msg" 17', 17);
// A glab message flag with no number after it: unreadable, never the branch.
kind('glab mr merge -m 17', "unreadable");

// ------------------------------------------------------------ review B: `&>` is a redirection
merges("gh pr merge &>/dev/null 17", 17);
merges("gh pr merge &>>/dev/null 17", 17);

// ------------------------------------------------------------ review C: expansion in the verb position
kind("X=erge; gh pr m$X 17", "unrecognised");
kind("gh pr m$(echo e)rge 17", "unrecognised");
// An expansion in an argument (not the verb) is still a readable merge.
merges("gh pr merge 17 --body \"$X\"", 17);
benign("gh pr view $N");

// ------------------------------------------------------------ review D: the REST door decides reads
kind("gh api -XPUT repos/o/r/pulls/17/merge", "merge");
kind("gh api --method GET -f state=merged repos/o/r/pulls/17/merge", "merge");
kind("bash -c 'gh api -X PUT repos/o/r/pulls/17/merge'", "unrecognised");

// ------------------------------------------------------------ hook: named refusals, no forge call
await setupLedgerPath();
for (const [cmd, reason] of [
  ["cat <<'EOF'\ndon't\nEOF\ngh pr merge 17", /cannot parse this command's quoting/],
  ["gh pr merge $PR", /unreadable PR number/],
  ['gh pr comment 5 --body "please merge"', /--body-file/],
  ['$(true)"gh" pr merge 12', /single plain `gh pr merge <N>`/],
] as const) {
  const r = await hookDecision(cmd, GOOD_ENTRIES);
  assert(r.block && reason.test(r.reason ?? ""), `hook refuses with a named reason: ${JSON.stringify(cmd)} — ${r.reason ?? "allowed"}`);
  assert(r.calls.length === 0, `hook refuses before any forge call: ${JSON.stringify(cmd)}`);
}
for (const cmd of ['echo "gh pr merge 12"', "gh pr comment 5 --body-file x.md", 'git commit -m "fix: refuse gh pr merge shapes"']) {
  const r = await hookDecision(cmd, []);
  assert(!r.block, `hook allows inert: ${JSON.stringify(cmd)} — ${r.reason ?? ""}`);
}
teardownLedger();

process.exit(exit);
