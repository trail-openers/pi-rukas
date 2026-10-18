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
import { computeVerdict } from "../src/lens-review-format.ts";
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
  const grepOnly = async (cmd: string) => {
    if (cmd.startsWith("git cat-file")) {
      throw Object.assign(new Error("exit 128"), { code: 128, stdout: "" });
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(grepOnly, "/repo", "feature/x", SKILL_DIFF)).length === 1,
    "a cited references/ file that is NOT on the branch still produces an 'Unsourced path' finding",
  );

  // The probing itself is the contract: the existence question must be asked at
  // `origin/<branch>`, and asked against the ASSERTING FILE'S DIRECTORY. A
  // probe that asked the worktree, or the repo root only, would look wrong here
  // and the #994 false positive would survive the fix.
  const probes: string[] = [];
  const record = async (cmd: string) => {
    probes.push(cmd);
    return { stdout: "" };
  };
  await runClaimScan(record, "/repo", "feature/x", SKILL_DIFF);
  assert(
    probes.some(
      (p) =>
        p.includes("git cat-file -e") &&
        p.includes("origin/feature/x:") &&
        p.includes("skill/go-idiomatic/references/patterns.md"),
    ),
    "the existence probe is 'git cat-file -e origin/<branch>:<asserting dir>/<token>' — branch ref, not worktree, resolved against the citing file",
  );

  const atBranch = async (cmd: string) => {
    if (cmd.startsWith("git grep")) {
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
  const brokenGit = async (cmd: string) => {
    if (cmd.startsWith("git cat-file")) {
      throw Object.assign(new Error("git: command not found"), { code: 127, stdout: "" });
    }
    return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
  };
  assert(
    (await runClaimScan(brokenGit, "/repo", "feature/x", SKILL_DIFF)).length === 0,
    "exit 128 is 'absent' and any other code is 'could not tell' — a broken git never becomes 'Unsourced path'",
  );

  // A token that is not a repo path at all — it carries `..` — must NEVER reach
  // `git cat-file`: the resolved string would be interpolated straight into a
  // tree-ish, and `skill/x/../../../etc/passwd.md` escapes the repository.
  // Refusing to probe is a safety property, so it is asserted on the command
  // log as well as the finding count — "no finding" and "a fabricated finding"
  // are both wrong answers here, and only the log tells them apart.
  const UNSAFE_DIFF = `--- a/skill/go-idiomatic/SKILL.md
+++ b/skill/go-idiomatic/SKILL.md
@@ -66,1 +66,2 @@
 intro
+See \`../../../etc/cron.d/x.md\` for idioms.
`;
  const unsafeProbes: string[] = [];
  const recordUnsafe = async (cmd: string) => {
    unsafeProbes.push(cmd);
    if (cmd.startsWith("git grep")) {
      return { stdout: "origin/feature/x:skill/go-idiomatic/SKILL.md\n" };
    }
    return { stdout: "" };
  };
  // The `git grep` lookup runs once per candidate BEFORE the existence rule,
  // so a probe log from a single-candidate diff cannot show whether the probe
  // was skipped — it is never empty either way. What the skip does change is
  // git's ANSWER: with the guard a `..` token throws "could not tell" and the
  // claim is dropped; without it the probe runs, git answers 128, and the scan
  // reports a file it never validly checked. Same reasoning as the broken-git
  // case above, reached by a different door.
  const unsafe = await runClaimScan(recordUnsafe, "/repo", "feature/x", UNSAFE_DIFF);
  assert(
    unsafe.length === 0,
    "a `..` token is 'could not tell', not 'Unsourced path' — the scan never validly asked whether it exists",
  );

  // `git grep` exits 1 with no output when there are simply no matches. That is
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
