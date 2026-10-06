#!/usr/bin/env bun
/**
 * Catching false claims in a diff — the nessie #658 class.
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
 */

import { extractClaimCandidates, groundClaims, isProseFile } from "../src/claim-scan.ts";
import { runClaimScan } from "../src/lens-evidence.ts";
import { computeVerdict } from "../src/lens-review.ts";
import type { Finding } from "../src/lens-review.ts";
import { pathsInDiff } from "../src/work-driver-diff.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------- defect #2, the real shape

const NESSIE_DIFF = `diff --git a/docs/deployment.md b/docs/deployment.md
--- a/docs/deployment.md
+++ b/docs/deployment.md
@@ -155,2 +155,4 @@
 Hardware requirements
+The reference host is an Intel i7 with 64 GB RAM and 2 TB of NVMe storage.
+Deployment is verified on that configuration before each release.
`;

{
  const c = extractClaimCandidates(NESSIE_DIFF);
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

// ----------------------------------- what must NOT be extracted (not vacuous)

{
  const diff = `--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,3 @@
 intro
+See Section 3 and Figure 2 for the 1.0 overview; roughly 100% of cases apply.
+\`\`\`
+Intel i9 inside a fenced block is an example, not a claim.
`;
  const tokens = extractClaimCandidates(diff).map((c) => c.token);
  assert(!tokens.includes("Section 3"), "'Section 3' is a cross-reference, not a specification");
  assert(!tokens.includes("Figure 2"), "'Figure 2' likewise");
  assert(!tokens.some((t) => t === "1.0"), "a bare '1.0' is prose, not a version claim");
  assert(!tokens.includes("100%"), "'100%' is rhetorical, and ignored by name");
  assert(
    !tokens.includes("Intel i9"),
    "a fenced code block is an example, not an assertion — the #407 'quoting is not asserting' rule",
  );
}

// ------------------------------- code files are not scanned; prose files are

{
  const diff = `--- a/src/spawn.ts
+++ b/src/spawn.ts
@@ -1,1 +1,2 @@
 x
+const CAP = 12; // tuned for a 64 GB host
`;
  assert(
    extractClaimCandidates(diff).length === 0,
    "a code file is not scanned — an assertion in a comment is not a published claim",
  );
  assert(isProseFile("docs/a.md") && !isProseFile("src/a.ts"), "prose classification");
  assert(
    pathsInDiff(NESSIE_DIFF).join() === "docs/deployment.md",
    "pathsInDiff reads the +++ side",
  );
}

// ------------------------------------------------------- the grounding rule

{
  const candidates = extractClaimCandidates(NESSIE_DIFF);

  // Nothing anywhere → ungrounded.
  const none = await groundClaims(candidates, async () => []);
  assert(none.length === candidates.length, "with no hits anywhere, every claim is ungrounded");

  // Found ONLY in prose → still ungrounded. Self-reference is not evidence; if
  // a doc could ground its own assertion, every invented spec would validate
  // itself.
  const proseOnly = await groundClaims(candidates, async () => ["docs/deployment.md", "README.md"]);
  assert(
    proseOnly.length === candidates.length,
    "a claim found ONLY in prose is still ungrounded — prose does not ground prose",
  );
  assert(
    proseOnly[0]?.proseHits.includes("docs/deployment.md"),
    "...and the prose hits are recorded, so the message can say where it looked",
  );

  // Found in code → grounded.
  const inCode = await groundClaims(candidates, async () => ["src/config.ts"]);
  assert(inCode.length === 0, "a claim backed by a code file is grounded and not reported");

  // A lookup that throws is "could not tell", never "fabricated".
  const threw = await groundClaims(candidates, async () => {
    throw new Error("git unavailable");
  });
  assert(
    threw.length === 0,
    "an unreadable repository yields NO findings — this gate blocks merges and must not manufacture one from its own failure",
  );
}

// ---- THE false-positive canary: this repo ships docs WITH the change (§7)

{
  // A PR that adds a constant and documents it in the same commit. The README
  // line is the only prose mention; the constant is an ADDED code line. If
  // same-diff code did not count as a referent, this fires — and it would fire
  // on nearly every honest PR in this repo.
  const diff = `--- a/README.md
+++ b/README.md
@@ -10,1 +10,2 @@
 env table
+| \`PI_ENSEMBLE_CLAIM_SCAN\` | \`1\` | Set to \`0\` to disable the claim scan. |
--- a/src/lens-evidence.ts
+++ b/src/lens-evidence.ts
@@ -1,1 +1,2 @@
 x
+  const v = process.env.PI_ENSEMBLE_CLAIM_SCAN;
`;
  const candidates = extractClaimCandidates(diff);
  assert(
    candidates.some((c) => c.token === "PI_ENSEMBLE_CLAIM_SCAN"),
    "the env var is extracted from the README line",
  );
  // The branch ref contains the added code line, so grep finds it in a .ts file.
  const grounded = await groundClaims(candidates, async (t) =>
    t === "PI_ENSEMBLE_CLAIM_SCAN" ? ["README.md", "src/lens-evidence.ts"] : ["src/x.ts"],
  );
  assert(
    grounded.length === 0,
    "a README citing a constant added in the SAME PR is grounded — docs-ship-with-the-change must not misfire",
  );
}

// ----------------------------------------------- end to end, with a fake git

{
  const exec = async (cmd: string) => {
    // Only the invented specs are absent from the branch.
    if (/Intel i7|64 GB|2 TB/.test(cmd)) {
      const e = Object.assign(new Error("exit 1"), { code: 1, stdout: "" });
      throw e;
    }
    return { stdout: "origin/feature/x:src/config.ts\n" };
  };
  const findings = await runClaimScan(exec, "/repo", "feature/x", NESSIE_DIFF);
  assert(findings.length === 3, "the scan produces one finding per invented spec");
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
    NESSIE_DIFF,
  );
  assert(allGrounded.length === 0, "when everything grounds, the scan is silent");

  const prev = process.env.PI_ENSEMBLE_CLAIM_SCAN;
  process.env.PI_ENSEMBLE_CLAIM_SCAN = "0";
  assert(
    (await runClaimScan(exec, "/repo", "feature/x", NESSIE_DIFF)).length === 0,
    "PI_ENSEMBLE_CLAIM_SCAN=0 disables it",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_CLAIM_SCAN;
  else process.env.PI_ENSEMBLE_CLAIM_SCAN = prev;
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
