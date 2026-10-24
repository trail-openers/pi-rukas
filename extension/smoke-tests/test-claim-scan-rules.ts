#!/usr/bin/env bun
/**
 * The extraction and grounding RULES, tested directly against pure `claim-scan.ts`.
 *
 * `test-claim-scan.ts` is the end-to-end suite: it drives `runClaimScan` with a
 * fake git and pins what the gate REPORTS. The assertions here are about the
 * rules themselves — which tokens are extracted, which are not, and what counts
 * as a referent — and need no git at all. Split out along that seam for the
 * 500-line gate (AGENTS.md §12).
 */

import { extractClaimCandidates, groundClaims, isProseFile } from "../src/claim-scan.ts";
import { pathsInDiff } from "../src/work-driver-diff.ts";
import { FIELD_DIFF } from "./lib/claim-scan-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
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
    pathsInDiff(FIELD_DIFF).join() === "docs/deployment.md",
    "pathsInDiff reads the +++ side",
  );
}

// ------------------------------------------------------- the grounding rule

{
  const candidates = extractClaimCandidates(FIELD_DIFF);

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

// ------------------- a path claim whose file exists on the branch (#1002)

{
  // The /work 994 shape, replayed. Six skills each cited a `references/` file
  // that exists next to the SKILL.md citing it, and the scan called all six
  // fabricated — because the target is itself prose, so the rule that grounds
  // nothing in prose could never ground any of it.
  const diff = `--- a/skill/devops-infrastructure/SKILL.md
+++ b/skill/devops-infrastructure/SKILL.md
@@ -63,1 +63,2 @@
 intro
+Read \`references/ci-cd.md\` for pipeline patterns.
`;
  const candidates = extractClaimCandidates(diff);
  assert(
    candidates.some((c) => c.token === "references/ci-cd.md" && c.kind === "path"),
    "the relative path is extracted as a path-kind claim — the shape that false-fired",
  );

  // Without the existence escape the old rule still fires: not vacuous.
  const noEscape = await groundClaims(candidates, async () => [
    "skill/devops-infrastructure/SKILL.md",
  ]);
  assert(
    noEscape.length === 1,
    "with no existence lookup injected, the pre-#1002 rule still flags it — the new test can fail",
  );

  // The file is there → grounded.
  const exists = await groundClaims(
    candidates,
    async () => ["skill/devops-infrastructure/SKILL.md"],
    async () => true,
  );
  assert(exists.length === 0, "a path claim whose file exists on the branch is grounded");

  // The file is not there → still a finding. The escape is an OR, not a pardon.
  const absent = await groundClaims(
    candidates,
    async () => ["skill/devops-infrastructure/SKILL.md"],
    async () => false,
  );
  assert(
    absent.length === 1,
    "a path claim whose file does NOT exist is still 'Unsourced path' — an invented reference is a defect",
  );

  // The escape answers a question, so it must receive the pair the question needs.
  const seen: Array<[string, string]> = [];
  await groundClaims(
    candidates,
    async () => [],
    async (t, f) => {
      seen.push([t, f]);
      return true;
    },
  );
  assert(
    seen[0]?.[0] === "references/ci-cd.md" &&
      seen[0]?.[1] === "skill/devops-infrastructure/SKILL.md",
    "the existence lookup is given the token AND the asserting file, so it can resolve against that directory",
  );

  // "Could not tell" is never "absent" — the gate blocks merges.
  const broke = await groundClaims(
    candidates,
    async () => [],
    async () => {
      throw new Error("git unavailable");
    },
  );
  assert(
    broke.length === 0,
    "an existence check that cannot read the branch drops the claim rather than fabricating a finding",
  );

  // The existence lookup is consulted AFTER the token-occurrence rule, as an
  // OR. Flip the order and a non-prose grep hit would be thrown away on path
  // claims — docs-ship-with-the-change would start firing again on every path a
  // PR documents alongside its own code.
  const grepFirst = await groundClaims(
    extractClaimCandidates(
      `--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,1 +1,2 @@
 intro
+See \`src/config.ts\`, which this PR adds.
`,
    ),
    async () => ["src/config.ts"],
    async () => {
      throw new Error("the existence lookup must not be reached once a code hit grounds the claim");
    },
  );
  assert(
    grepFirst.length === 0,
    "a path claim already grounded by a non-prose grep hit never pays for the existence probe — the escape is an OR, evaluated second",
  );

  // The escape is kind-gated. `Serverless v2` at postgres-database/SKILL.md:83
  // is a product claim described only in prose, and the ticket keeps it a
  // finding: a file that exists must not vouch for a spec that is not a path.
  const productDiff = `--- a/skill/postgres-database/SKILL.md
+++ b/skill/postgres-database/SKILL.md
@@ -82,1 +82,2 @@
 intro
+Read \`references/aurora-aws.md\` for Aurora cluster, Serverless v2, and scaling.
`;
  const productCandidates = extractClaimCandidates(productDiff);
  assert(
    productCandidates.some((c) => c.token === "Serverless v2" && c.kind === "product"),
    "'Serverless v2' is extracted as a product claim — the out-of-scope shape",
  );
  const productUngrounded = await groundClaims(
    productCandidates.filter((c) => c.kind === "product"),
    async () => [
      "skill/postgres-database/SKILL.md",
      "skill/postgres-database/references/aurora-aws.md",
    ],
    async () => true,
  );
  assert(
    productUngrounded.length === 1 && productUngrounded[0]?.token === "Serverless v2",
    "existence grounds paths only — a product claim described solely in prose stays ungrounded",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
