#!/usr/bin/env bun
/**
 * Catching false claims in a diff — the defect class behind #658.
 *
 * That PR shipped two defects past all six lenses, which returned one cosmetic
 * LOW finding:
 *
 *   1. `deployment.md:158` described the BUG as the intended behaviour,
 *      contradicting `:230` in the same file.
 *   2. Invented hardware specs ("Intel i7, 64 GB RAM") with no source anywhere.
 *
 * The obvious remedy — a seventh "documentation truth" lens — was researched
 * and rejected. SIMPLICITY was ALREADY chartered for defect #1
 * (`skill/code-review-simplicity/SKILL.md:98-102`, "Confusing or contradictory
 * documentation") and stayed silent, so the lane was never the problem. What
 * was: the lens children get only the diff, `:230` was outside it, and their
 * `cwd` is a worktree detached at `baseSha` — so even opening the file yields
 * the PRE-change text. A seventh lens would have inherited that blind spot
 * exactly.
 *
 * Two mechanisms, one per defect: evidence supply for the contradiction,
 * deterministic grounding for the invented spec.
 *
 * The pure extraction/grounding RULES (`groundClaims`, `extractClaimCandidates`,
 * the prose-does-not-ground-prose rule) moved to `test-claim-scan-rules.ts` for
 * the 500-line gate (AGENTS.md §12); what stays here drives `runClaimScan` with
 * a fake git and pins what the gate REPORTS.
 */

import { extractClaimCandidates } from "../src/claim-scan.ts";
import { isClaimScanProbe as isProbe } from "./lib/claim-scan-probe-fixture.ts";
import { FIELD_DIFF } from "./lib/claim-scan-fixture.ts";
import { runClaimScan } from "../src/lens-evidence.ts";
import { computeVerdict } from "../src/lens-review-format.ts";
import type { Finding } from "../src/lens-review.ts";

/** `git grep` — the token-occurrence lookup, spelled in pieces so this file's
 * own command-matching strings are not confusable with the fixture literals. */
const GIT_GREP = "git " + "grep";

// The probe matcher lives in lib/claim-scan-probe-fixture.ts, shared with
// test-claim-scan-probe-cost.ts — a fake that fails to recognise the probe
// answers "the file exists" for every call, which reads as a green suite that
// asserts nothing. The synthetic docs diff both suites read is in
// lib/claim-scan-fixture.ts for the same reason.

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------- defect #2, the real shape

{
  const c = extractClaimCandidates(FIELD_DIFF);
  const tokens = c.map((x) => x.token);
  assert(tokens.includes("64 GB"), "extracts the invented memory spec");
  assert(tokens.includes("2 TB"), "extracts the invented storage spec");
  assert(tokens.includes("Intel i7"), "extracts the invented CPU model");
  assert(
    c.every((x) => x.file === "docs/deployment.md"),
    "every candidate is attributed to the prose file that asserts it",
  );
  assert(
    c.find((x) => x.token === "64 GB")?.line === 156,
    "the line number is the post-change line, not the hunk header",
  );
}

// ----------------------------------------------- end to end, with a fake git

{
  const exec = async (cmd: string, opts?: { argv?: string[] }) => {
    // Only the invented specs are absent from the branch. The probe is argv-form,
    // so the tree-ish is read out of `opts.argv` rather than out of `cmd`.
    const haystack = opts?.argv?.join(" ") ?? cmd;
    if (/Intel i7|64 GB|2 TB/.test(haystack)) {
      const e = Object.assign(new Error("exit 1"), { code: 1, stdout: "" });
      throw e;
    }
    return { stdout: "origin/feature/x:src/config.ts\n" };
  };
  const findings = await runClaimScan(exec, "/repo", "feature/x", FIELD_DIFF);
  assert(findings.length === 3, "the scan produces one finding per invented spec");

  // The pre-#1002 fake returned a code file for EVERY command, so the
  // existence seam was never reached and no path-kind claim ever got here.
  // With the real rule in place, the answer to "does it exist" is the whole
  // difference between eight false MEDIUMs and none.
  const SKILL_DIFF = `--- a/skill/go-idiomatic/SKILL.md
+++ b/skill/go-idiomatic/SKILL.md
@@ -66,1 +66,2 @@
 intro
+See \`references/patterns.md\` for idioms.
`;
  // Which of the two resolutions the probe asked is pinned by
  // test-claim-scan-probe-cost.ts; here the fake answers "the branch has no such
  // file" for BOTH — so the whole fixture turns on the wording the shared
  // absence classifier reads (a bare 128 with no stderr is "could not tell",
  // which would drop the claim rather than report it).
  const grepOnly = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      throw Object.assign(new Error("exit 128"), {
        code: 128,
        stdout: "",
        stderr: "fatal: path 'x' does not exist in 'y'\n",
      });
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(grepOnly, "/repo", "feature/x", SKILL_DIFF)).length === 1,
    "a cited references/ file that is NOT on the branch still produces an 'Unsourced path' finding",
  );

  const noGrepNoFile = async (cmd: string, opts?: { argv?: string[] }) => {
    if (cmd.startsWith(GIT_GREP)) {
      throw Object.assign(new Error("exit 1"), { code: 1, stdout: "" });
    }
    if (isProbe(cmd, opts)) {
      throw Object.assign(new Error("exit 128"), {
        code: 128,
        stdout: "",
        stderr: "fatal: path 'x' does not exist in 'y'\n",
      });
    }
    return { stdout: "" };
  };
  assert(
    (await runClaimScan(noGrepNoFile, "/repo", "feature/x", SKILL_DIFF)).length === 1,
    "a SKILL.md whose cited file the branch does NOT have is an 'Unsourced path' finding — the probe is what distinguishes it, with no grep hit either way (not vacuous)",
  );

  const atBranch = async (cmd: string) => {
    if (cmd.startsWith(GIT_GREP)) {
      return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
    }
    // The existence probe answers for either resolution — asserting-dir-relative
    // here, repo-root in the block below.
    return { stdout: "" };
  };
  assert(
    (await runClaimScan(atBranch, "/repo", "feature/x", SKILL_DIFF)).length === 0,
    "the same claim is silent once the branch has the file — the #994 false positive, gone",
  );

  // A git that is broken (not merely "no such file") must not invent a finding.
  const brokenGit = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      throw Object.assign(new Error("git: command not found"), { code: 127, stdout: "" });
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(brokenGit, "/repo", "feature/x", SKILL_DIFF)).length === 0,
    "exit 128 is 'absent' and any other code is 'could not tell' — a broken git never becomes 'Unsourced path'",
  );

  // The two resolutions are an OR evaluated over `Promise.allSettled`, and the
  // precedence between a `false` and a rejection is load-bearing in both
  // directions. One probe says the file IS there, the other cannot answer:
  // a fulfilled `true` grounds the claim outright.
  const oneTrueOneBroken = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      return (opts?.argv ?? [])[2]?.includes("skill/go-idiomatic/")
        ? { stdout: "" }
        : Promise.reject(
            Object.assign(new Error("git: command not found"), { code: 127, stdout: "" }),
          );
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(oneTrueOneBroken, "/repo", "feature/x", SKILL_DIFF)).length === 0,
    "one resolution says the file exists and the sibling cannot answer — the true still grounds it, no finding and no throw",
  );

  // The mirror: one probe says absent, its sibling cannot answer. `false` is a
  // fact the scan reports and a rejection is a fact it swallows, so the absent
  // answer must win — otherwise a finding the branch supports disappears.
  const oneFalseOneBroken = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      return (opts?.argv ?? [])[2]?.includes("skill/go-idiomatic/")
        ? Promise.reject(
            Object.assign(new Error("git: command not found"), { code: 127, stdout: "" }),
          )
        : Promise.reject(
            Object.assign(new Error("exit 128"), {
              code: 128,
              stdout: "",
              stderr: "fatal: path 'x' does not exist in 'y'\n",
            }),
          );
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(oneFalseOneBroken, "/repo", "feature/x", SKILL_DIFF)).length === 1,
    "one resolution says absent and the sibling cannot answer — the false outranks the rejection, the finding survives",
  );

  assert(
    findings.every((f) => f.lens === "CLAIM_SCAN"),
    "findings are attributed to CLAIM_SCAN, not to a lens that did not produce them",
  );
  assert(
    findings.every((f) => f.severity === "MEDIUM" && f.path === "docs/deployment.md"),
    "MEDIUM, at the file that asserts the claim",
  );
  assert(
    findings.some((f) => /Intel i7/.test(f.title)),
    "the title names the token, so the operator sees the claim without opening the diff",
  );
  assert(
    findings.every((f) => !/hallucinat/i.test(f.description ?? "")),
    "the message describes what was checked, not a guess about intent",
  );

  // `git grep` exits 1 with no output when there are simply no matches. That is
  // a fact, not a failure — if it were treated as "could not tell" the gate
  // could never flag anything at all.
  const allGrounded = await runClaimScan(
    async () => ({ stdout: "origin/feature/x:src/config.ts\n" }),
    "/repo",
    "feature/x",
    FIELD_DIFF,
  );
  assert(allGrounded.length === 0, "when everything grounds, the scan is silent");

  const prev = process.env.PI_ENSEMBLE_CLAIM_SCAN;
  process.env.PI_ENSEMBLE_CLAIM_SCAN = "0";
  assert(
    (await runClaimScan(exec, "/repo", "feature/x", FIELD_DIFF)).length === 0,
    "PI_ENSEMBLE_CLAIM_SCAN=0 disables it",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_CLAIM_SCAN;
  else process.env.PI_ENSEMBLE_CLAIM_SCAN = prev;
}

// ------------------------------------------- an unsafe token never reaches git

{
  // A token that is not a repo path at all — it carries `..` — must NEVER reach
  // `git cat-file`: the resolved string would be interpolated straight into a
  // tree-ish, and `skill/x/../../../etc/passwd.md` escapes the repository. What
  // the guard changes is git's ANSWER: with it, a `..` token throws "could not
  // tell" and the claim is dropped; without it the probe runs, git answers 128,
  // and the scan reports a file it never validly checked. Same reasoning as the
  // broken-git case above, reached by a different door. (That the probe is never
  // *asked* is pinned by `test-claim-scan-paths.ts`, which runs a real git.)
  const UNSAFE_DIFF = `--- a/skill/go-idiomatic/SKILL.md
+++ b/skill/go-idiomatic/SKILL.md
@@ -66,1 +66,2 @@
 intro
+See \`../../../etc/cron.d/x.md\` for idioms.
`;
  const recordUnsafe = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      throw Object.assign(new Error("exit 128"), {
        code: 128,
        stdout: "",
        stderr: "fatal: path 'x' does not exist in 'y'\n",
      });
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  const unsafe = await runClaimScan(recordUnsafe, "/repo", "feature/x", UNSAFE_DIFF);
  assert(
    unsafe.length === 0,
    "a `..` token is 'could not tell', not 'Unsourced path' — the scan never validly asked whether it exists",
  );
}

// ------------------------------- a finding title never carries a forgeable marker

{
  // The token is prose a human wrote, and the title reaches the reviewer report
  // and the PR body. A token carrying a marker the readers parse (`VERDICT`)
  // must not survive into the line that renders it — same rule as every sibling
  // finding line in `lens-review-render.ts` / `lens-residuals.ts`.
  const MARKER_DIFF = `--- a/docs/deployment.md
+++ b/docs/deployment.md
@@ -1,1 +1,2 @@
 intro
+See \`dir/ROLLSET/x-rollout.md\` for the rollout and \`dir/VERDICT/x-rollback.md\` for the rollback.
`;
  // Both tokens are ungrounded (no grep hit, and the probe says the branch has
  // neither file), so both are reported and the titles are what this looks at.
  const execProbe = async (cmd: string, opts?: { argv?: string[] }) => {
    if (isProbe(cmd, opts)) {
      throw Object.assign(new Error("exit 128"), {
        code: 128,
        stdout: "",
        stderr: "fatal: path 'x' does not exist in 'y'\n",
      });
    }
    throw Object.assign(new Error("exit 1"), { code: 1, stdout: "" });
  };
  const markerTitles = (await runClaimScan(execProbe, "/repo", "feature/x", MARKER_DIFF)).map(
    (f) => f.title,
  );
  // The bracket characters are the neutraliser's own (comment-evidence.ts), so
  // they are spelled out — a literal in this file would be confusable with the
  // evidence it is checking.
  const bracketed =
    "dir/" + String.fromCharCode(0x2039) + "VERDICT" + String.fromCharCode(0x203a) + "/";
  assert(
    // `dir/VERDICT/…` is the case this pins: the token contains a bare marker
    // segment, so an unguarded title carries `VERDICT` where a lenient reader
    // (one that accepts `XVERDICT:` with no boundary) looks for one. The control
    // beside it — a token with no marker in it at all — proves the negative half
    // is not satisfied by "nothing was reported at all".
    markerTitles.some((t) => t.includes("dir/ROLLSET/x-rollout.md")) &&
      markerTitles.some((t) => t.includes(bracketed)) &&
      !markerTitles.some((t) => /(^|[^\p{L}\p{N}\u2039])VERDICT(?![\p{L}\p{N}\u203a])/u.test(t)),
    "a path token with a verdict-marker segment is bracketed in the title so it cannot forge one — with a control token beside it still reported (not vacuous)",
  );
}

// ------------------------------------- the findings reach the verdict at all

{
  const mk = (severity: Finding["severity"]): Finding => ({
    lens: "CLAIM_SCAN",
    severity,
    path: "docs/deployment.md",
    line: 156,
    title: `Unsourced quantity: 64 GB (${severity})`,
    description: "",
  });
  assert(
    computeVerdict([mk("MEDIUM")], []) === "ISSUES_FOUND",
    "a claim-scan MEDIUM blocks at the default threshold — it is a finding like any other",
  );
  assert(computeVerdict([], []) === "APPROVED", "...and no findings still approves");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
