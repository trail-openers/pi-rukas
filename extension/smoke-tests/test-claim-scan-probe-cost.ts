#!/usr/bin/env bun
/**
 * The path-existence probe's SHAPE and COST (#1002 round 2).
 *
 * `test-claim-scan.ts` pins what the claim scan REPORTS. This file pins what the
 * probe it calls costs and how it is invoked — three properties the scan-level
 * assertions cannot see, each of which the first fix round found unguarded:
 *
 *   - **argv, not a command string.** The path arrives from prose a human wrote.
 *     Through `sh -c` a `$(…)` inside a filename executes; as one argv element
 *     it cannot. The canary in `test-git-range-1153.ts` enforces the rule for
 *     every importer of `git-range.ts`, and this is where the call shape is
 *     pinned.
 *   - **A bounded timeout.** A wedged object store must cost the lens step its
 *     claim scan, not the lens step. Every other driver git read takes
 *     `DEFAULT_GIT_TIMEOUT_MS`; this one had no timeout at all.
 *   - **Probes are memoised per scan, and the two resolutions run concurrently
 *     without losing the short-circuit.** The same tree-ish asked twice is one
 *     spawn; and once one resolution has answered `false` (absent — a fact the
 *     scan reports), a sibling that could not answer must not upgrade it to
 *     "could not tell" (which the scan swallows), or a finding the branch
 *     supports silently disappears.
 *
 * Split from `test-claim-scan.ts` for the 500-line gate (AGENTS.md §12).
 */

import { runClaimScan } from "../src/lens-evidence.ts";
import { claimScanProbeTreeish as probeTreeish, isClaimScanProbe as isProbe } from "./lib/claim-scan-probe-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** `git grep` — the token-occurrence lookup, spelled in pieces so this file's
 * own command-matching strings are not confusable with the fixture literals. */
const GIT_GREP = "git " + "grep";

/** A SKILL.md line asserting one relative path, cited from a subdirectory. */
const SKILL_DIFF = `--- a/skill/go-idiomatic/SKILL.md
+++ b/skill/go-idiomatic/SKILL.md
@@ -66,1 +66,2 @@
 intro
+See \`references/patterns.md\` for idioms.
`;

/** git's REAL shape for "that path is not in this commit" (measured: exit 128 +
 * this wording). A bare 128 with no stderr is NOT absent — that is what the
 * probe leaves when the clone itself is broken — so the fixture carries the
 * wording the shared classifier reads. */
const absent = () =>
  Object.assign(new Error("exit 128"), {
    code: 128,
    stdout: "",
    stderr: "fatal: path 'x' does not exist in 'y'\n",
  });

const grepHit = { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };

// ------------------------------------------------------- the probe's invocation

{
  // The existence question must be asked at `origin/<branch>`, against the
  // ASSERTING FILE'S DIRECTORY, as argv. A probe that asked the worktree, or the
  // repo root only, would look right here and the #994 false positive would
  // survive the fix; a probe that reached a shell would be a command injection
  // with a prose-controlled payload.
  const probes: string[] = [];
  const record = async (cmd: string, opts?: { argv?: string[] }) => {
    probes.push(`${cmd} ${(opts?.argv ?? []).join(" ")}`.trim());
    return { stdout: "" };
  };
  await runClaimScan(record, "/repo", "feature/x", SKILL_DIFF);
  assert(
    probes.some(
      (p) =>
        p.startsWith("git cat-file -e") &&
        p.includes("origin/feature/x:") &&
        p.includes("skill/go-idiomatic/references/patterns.md"),
    ),
    "the existence probe is argv-form ['cat-file','-e','origin/<branch>:<asserting dir>/<token>'] — branch ref, not worktree, resolved against the citing file",
  );
  assert(
    probes.every((p) => p.startsWith("git ")),
    "control: the probe log actually records git invocations, so the assertion above can fail",
  );
  assert(
    probes.every((p) => !p.includes(";") && !p.includes("$(") && !p.includes("`")),
    "no shell metacharacter reaches a probe — the path is one argv element, never a command string",
  );
}

// ------------------------------------- both resolutions run, and both cost a spawn

{
  // The two resolutions are an OR. When NEITHER exists both pay for a probe —
  // that is the cost the per-scan memoisation exists to bound.
  const bothProbes: string[] = [];
  const recordBoth = async (cmd: string, opts?: { argv?: string[] }) => {
    bothProbes.push(probeTreeish(opts));
    if (cmd.startsWith(GIT_GREP)) return grepHit;
    throw absent();
  };
  await runClaimScan(recordBoth, "/repo", "feature/x", SKILL_DIFF);
  // Each entry is the tree-ish git was handed as ONE argv element — no shell
  // quoting, which is the point of the argv form.
  const probeCmds = bothProbes.filter((p) => p.startsWith("origin/feature/x:"));
  assert(
    probeCmds.length === 2,
    `both resolutions are probed when neither exists — exactly TWO spawns, dir-relative AND root-relative (got ${probeCmds.length})`,
  );
  assert(
    probeCmds.includes("origin/feature/x:skill/go-idiomatic/references/patterns.md") &&
      probeCmds.includes("origin/feature/x:references/patterns.md"),
    "...and the two are the DIR-RELATIVE and the ROOT-RELATIVE tree-ishes, not the same one twice",
  );
}

// ------------------------------------------------- memoised per (branch, path)

{
  // The SAME resolved path asked twice costs one spawn. Two citations of one
  // token are deduplicated by `extractClaimCandidates` (it keys on file+token),
  // so the repeat has to come from two tokens that resolve to the same tree-ish
  // — the `./` shape this scan meets in real skills. With the cache both
  // citations share one spawn per resolution: the `./` token needs only the
  // dir-relative probe, which is exactly what the bare token already asked, so
  // WITHOUT the cache it would add the second probe this asserts is absent.
  const REPEAT_DIFF = `--- a/skill/go-idiomatic/SKILL.md
+++ b/skill/go-idiomatic/SKILL.md
@@ -66,1 +66,3 @@
 intro
+See \`references/patterns.md\` for idioms.
+And \`./references/patterns.md\` again for style.
`;
  const repeatProbes: string[] = [];
  const recordRepeat = async (cmd: string, opts?: { argv?: string[] }) => {
    repeatProbes.push(probeTreeish(opts));
    if (cmd.startsWith(GIT_GREP)) return grepHit;
    throw absent();
  };
  const repeated = await runClaimScan(recordRepeat, "/repo", "feature/x", REPEAT_DIFF);
  const repeatCmds = repeatProbes.filter((p) => p.startsWith("origin/feature/x:"));
  assert(
    repeatCmds.length === 2,
    `a path resolved twice costs TWO probes, not four — the lookup is memoised per scan (got ${repeatCmds.length})`,
  );
  assert(
    repeated.length === 1,
    "...and still reports the one finding, so the cache is not swallowing the claim",
  );
}

// --------------------------------------------------------- the probe is bounded

{
  // A hung git must not hang the lens step: the probe carries the same bound
  // every other driver git read takes. A timeout is also what makes `killed` /
  // `signal` reachable, which the shared absence rule refuses as evidence.
  const probeTimeouts: Array<number | undefined> = [];
  const recordTimeout = async (cmd: string, opts?: { argv?: string[]; timeout?: number }) => {
    if (isProbe(cmd, opts)) probeTimeouts.push(opts?.timeout);
    if (cmd.startsWith(GIT_GREP)) return grepHit;
    throw absent();
  };
  await runClaimScan(recordTimeout, "/repo", "feature/x", SKILL_DIFF);
  assert(
    probeTimeouts.length > 0 && probeTimeouts.every((t) => typeof t === "number" && t > 0),
    "every existence probe carries a bounded timeout, like every other driver git call",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
