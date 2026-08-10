#!/usr/bin/env bun
/**
 * Evidence supply and the blocking threshold.
 *
 * ## Why evidence supply exists
 *
 * The reviewed diff is built from `origin/<base>..origin/<branch>`
 * (`work-driver-diff.ts` → `readIntegratedDiff`), but the lens children run
 * with `cwd` set to a worktree, and `readAllMergedDiffs` records the invariant
 * that those "stay DETACHED at baseSha". So a reviewer that opens a changed
 * file reads the version from BEFORE the change — and `role-tools.ts` strips
 * only write/edit/multiedit, so reviewers very much can open files.
 *
 * That is what let a documentation paragraph contradicting another paragraph in
 * the same file pass six lenses: the contradicting line was outside the diff,
 * and the file on disk was the pre-change copy. The first block here builds a
 * REAL git repo in that exact configuration and asserts the supplied content is
 * the branch version.
 *
 * ## Why the threshold is here too
 *
 * A lens assigns severity; the project decides which severity blocks. That was
 * hardcoded, and `AGENTS.md §1`'s "blocking at MEDIUM and above" was read by
 * nobody. The rule differs from merge authority ON PURPOSE: authority fails
 * closed, configuration falls back to the default — because a repo with no
 * AGENTS.md at all is the normal case, not an error.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildEvidence } from "../src/lens-evidence.ts";
import { LENSES, lensPromptFor } from "../src/lens-review-format.ts";
import { DEFAULT_REVIEW_THRESHOLD, computeVerdict } from "../src/lens-review.ts";
import type { Finding } from "../src/lens-review.ts";
import { resolveReviewThreshold } from "../src/review-threshold.ts";
import { pathsInDiff, readFileAtBranch } from "../src/work-driver-diff.ts";
import type { DoctrineDoc } from "../src/work-driver-policy.ts";

const execFileAsync = promisify(execFile);
const sh = async (cmd: string, cwd: string) => {
  const { stdout } = await execFileAsync("sh", ["-c", cmd], { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-evidence-"));

// ------------------- the wrong-tree canary, against a real detached worktree

{
  const origin = path.join(tmp, "origin.git");
  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo, { recursive: true });
  await sh(`git init -q --bare "${origin}"`, tmp);
  await sh(
    `git init -q && git config user.email t@t && git config user.name t && git remote add origin "${origin}"`,
    repo,
  );

  // Base: the file says 30 seconds, at what will be line 3.
  await fs.mkdir(path.join(repo, "docs"), { recursive: true });
  // The contradicting line must be FAR from the change, or git's 3 lines of
  // context would include it and there would be no problem to solve. In the
  // real incident the two paragraphs were ~70 lines apart.
  const filler = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1} of the guide.`).join(
    "\n",
  );
  const BASE = `# Deploy\n\nThe default timeout is 30 seconds.\n${filler}\n`;
  await fs.writeFile(path.join(repo, "docs/deployment.md"), BASE);
  await sh("git add -A && git commit -q -m base && git push -q origin HEAD:main", repo);
  const baseSha = (await sh("git rev-parse HEAD", repo)).trim();

  // Branch: a paragraph is appended that CONTRADICTS the line above, and the
  // contradiction is the only thing in the diff.
  const BRANCH = `${BASE}\nOperators should assume there is no timeout at all.\n`;
  await fs.writeFile(path.join(repo, "docs/deployment.md"), BRANCH);
  await sh(
    "git checkout -q -b feature/x && git add -A && git commit -q -m branch && git push -q origin feature/x",
    repo,
  );

  // Now put the repo back at base — this is the state a lens child's cwd is in.
  await sh(`git checkout -q ${baseSha}`, repo);
  const onDisk = await fs.readFile(path.join(repo, "docs/deployment.md"), "utf8");
  assert(
    onDisk === BASE && !onDisk.includes("no timeout at all"),
    "canary: the filesystem a reviewer would read is the BASE version — the change is not there",
  );

  const atBranch = await readFileAtBranch(repo, "feature/x", "docs/deployment.md");
  assert(atBranch === BRANCH, "readFileAtBranch returns the BRANCH version, not what is on disk");

  const diff = await sh("git diff origin/main..origin/feature/x", repo);
  assert(
    diff.includes("no timeout at all") && !diff.includes("30 seconds"),
    "...and the diff alone contains the new claim but NOT the line it contradicts — the whole problem",
  );

  const evidence = await buildEvidence(repo, "feature/x", diff);
  assert(evidence !== undefined, "evidence is built for a diff touching a prose file");
  assert(
    (evidence ?? "").includes("The default timeout is 30 seconds."),
    "the contradicting line IS in the supplied evidence — this is the assertion that fails today",
  );
  assert(
    (evidence ?? "").includes("no timeout at all"),
    "...alongside the new claim, so one reviewer sees both at once",
  );
  assert(
    /AFTER this PR/.test(evidence ?? ""),
    "the block says plainly that this is the post-change file",
  );

  // Not vacuous: a code-only diff supplies nothing.
  const codeDiff = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,2 @@\n x\n+const y = 1;\n";
  assert(
    (await buildEvidence(repo, "feature/x", codeDiff)) === undefined,
    "a diff with no prose files supplies no evidence — the diff is not buried for nothing",
  );
  assert(pathsInDiff(codeDiff).join() === "src/x.ts", "pathsInDiff on a code diff");

  const missing = await readFileAtBranch(repo, "feature/x", "docs/nope.md");
  assert(missing === undefined, "a file absent at the branch yields undefined, not a throw");
  assert(
    (await readFileAtBranch(repo, "feature/x; rm -rf /", "docs/deployment.md")) === undefined,
    "a ref that is not a plain name is rejected before it reaches the shell",
  );

  // The delivery point: evidence must actually reach the child's prompt, and
  // every lens must be told its filesystem is stale. A helper that builds
  // evidence nobody is given would pass every assertion above.
  const prompt = lensPromptFor(LENSES[5], diff, "ctx", evidence);
  assert(
    prompt.includes("The default timeout is 30 seconds."),
    "the evidence reaches the rendered lens prompt",
  );
  assert(
    /working directory is NOT the branch/i.test(prompt) && /base commit/.test(prompt),
    "...and every lens is warned that opening a file yields the pre-change version",
  );
  assert(
    !lensPromptFor(LENSES[0], diff, "ctx").includes("The default timeout is 30 seconds."),
    "...while a prompt built without evidence carries none (not vacuous)",
  );

  const prev = process.env.PI_ENSEMBLE_LENS_EVIDENCE;
  process.env.PI_ENSEMBLE_LENS_EVIDENCE = "0";
  assert(
    (await buildEvidence(repo, "feature/x", diff)) === undefined,
    "PI_ENSEMBLE_LENS_EVIDENCE=0 disables supply",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_LENS_EVIDENCE;
  else process.env.PI_ENSEMBLE_LENS_EVIDENCE = prev;
}

// ------------------------------------------------------------- the threshold

const mk = (severity: Finding["severity"]): Finding => ({
  lens: "SIMPLICITY",
  severity,
  path: "src/a.ts",
  line: 1,
  title: `a ${severity} finding`,
  description: "",
});

{
  assert(DEFAULT_REVIEW_THRESHOLD === "MEDIUM", "the shipped default is MEDIUM");
  assert(
    computeVerdict([mk("MEDIUM")], []) === "ISSUES_FOUND",
    "by default a MEDIUM finding blocks — today's behaviour, unchanged",
  );
  assert(
    computeVerdict([mk("MEDIUM")], [], "HIGH") === "APPROVED",
    "a project that sets HIGH lets a MEDIUM through",
  );
  assert(computeVerdict([mk("HIGH")], [], "HIGH") === "ISSUES_FOUND", "...but not a HIGH");
  assert(
    computeVerdict([mk("LOW")], [], "LOW") === "ISSUES_FOUND",
    "a project may tighten to LOW and block on everything",
  );
  assert(
    computeVerdict([mk("CRITICAL")], [], "LOW") === "CRITICAL_ISSUES_FOUND",
    "CRITICAL blocks whatever the threshold says — no project gets to wave one through",
  );
  assert(computeVerdict([mk("LOW")], []) === "APPROVED", "a LOW alone still approves by default");
}

// ------------------------- resolution: absent doctrine is normal, not an error

const judgeSaying = (a: Record<string, unknown> | undefined) => async () => ({
  toolUses: a ? [{ name: "report_policy", arguments: a }] : [],
});
const docs = (text: string): DoctrineDoc[] => [{ file: "AGENTS.md", text }];

{
  const none = await resolveReviewThreshold(judgeSaying(undefined), []);
  assert(
    none.severity === "MEDIUM" && none.source === "default",
    "NO AGENTS.md at all → MEDIUM. A repo without doctrine is the normal case, not a failure",
  );

  const silent = await resolveReviewThreshold(
    judgeSaying({ verdict: "unstated" }),
    docs("# Contributing\n\nRun the tests.\n"),
  );
  assert(
    silent.severity === "MEDIUM" && silent.source === "default",
    "doctrine that never mentions review severity → MEDIUM",
  );

  const SENT = "Six-pass review findings are blocking at HIGH severity and above.";
  const set = await resolveReviewThreshold(
    judgeSaying({ verdict: "permitted", quote: SENT, sourceFile: "AGENTS.md" }),
    docs(`## 1. Gates\n\n${SENT}\n`),
  );
  assert(
    set.severity === "HIGH" && set.source === "doctrine",
    "a project that states HIGH gets HIGH, with the sentence recorded",
  );
  assert(set.quote === SENT, "...verbatim");

  // The #407 citation check carries straight over: an invented sentence cannot
  // loosen the bar.
  const fabricated = await resolveReviewThreshold(
    judgeSaying({
      verdict: "permitted",
      quote: "Only CRITICAL findings block a merge in this project.",
      sourceFile: "AGENTS.md",
    }),
    docs("# Contributing\n\nRun the tests.\n"),
  );
  assert(
    fabricated.severity === "MEDIUM" && fabricated.source === "default",
    "a FABRICATED sentence cannot loosen the bar — the citation must exist",
  );

  const prev = process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
  process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = "critical";
  const op = await resolveReviewThreshold(judgeSaying({ verdict: "unstated" }), docs("x"));
  assert(
    op.severity === "CRITICAL" && op.source === "operator",
    "the operator's env override wins, case-insensitively",
  );
  process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = "nonsense";
  assert(
    (await resolveReviewThreshold(judgeSaying({ verdict: "unstated" }), docs("x"))).severity ===
      "MEDIUM",
    "a nonsense override is ignored rather than obeyed",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
  else process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = prev;
}

// --------------------------------- this repo's own AGENTS.md §1, end to end

{
  const root = path.resolve(import.meta.dirname, "..", "..");
  const text = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert(
    /blocking at MEDIUM severity and above/i.test(text),
    "pi-ensemble's own AGENTS.md still states MEDIUM — the sentence the code now reads",
  );
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
