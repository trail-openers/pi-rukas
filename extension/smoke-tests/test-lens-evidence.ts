#!/usr/bin/env bun
/**
 * Evidence supply: the lens child must read the BRANCH version of a changed
 * file, not the pre-change copy its detached cwd holds.
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
 * The blocking BAR is a separate concern with its own suite — `test-review-bar.ts`
 * (split out for AGENTS.md §12's file-size limit).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildEvidence } from "../src/lens-evidence.ts";
import { lensPromptFor } from "../src/lens-review-format.ts";
import { buildLensRoster } from "../src/lens-roster.ts";
import { pathsInDiff, readFileAtBranch } from "../src/work-driver-diff.ts";
import { assert, failureCount } from "./lib/review-bar-helpers.ts";

const execFileAsync = promisify(execFile);
const sh = async (cmd: string, cwd: string) => {
  const { stdout } = await execFileAsync("sh", ["-c", cmd], { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-evidence-"));

// The repo's own skill/ dir is the offline stand-in for the installed skills
// dir (never ~/.pi). Lens lookups are by name, not by array index — the
// roster is data now and its length is not 6 by contract.
const EVIDENCE_ROSTER = buildLensRoster(path.resolve(import.meta.dirname, "..", "..", "skill"));
const LENS_SIMPLE = EVIDENCE_ROSTER.find((e) => e.name === "SIMPLICITY")!;
const LENS_SECURITY = EVIDENCE_ROSTER.find((e) => e.name === "SECURITY")!;

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
  const prompt = lensPromptFor(LENS_SIMPLE, diff, "ctx", evidence, EVIDENCE_ROSTER);
  assert(
    prompt.includes("The default timeout is 30 seconds."),
    "the evidence reaches the rendered lens prompt",
  );
  assert(
    /working directory is NOT the branch/i.test(prompt) && /base commit/.test(prompt),
    "...and every lens is warned that opening a file yields the pre-change version",
  );
  assert(
    !lensPromptFor(LENS_SECURITY, diff, "ctx", undefined, EVIDENCE_ROSTER).includes(
      "The default timeout is 30 seconds.",
    ),
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

// #952 — canary: the exact stop sentence must appear in BOTH terminal branches
// of lensPromptFor. The findings branch (above) is already covered by the
// prompt assertion; the clean-lane branch ("If you find nothing… one-sentence
// summary") is the one with zero existing prompt-text coverage.
{
  const STOP_SENTENCE =
    // #1847 — the sentence now also tells the child its skill is inlined, so a
    // lens that finished could not go and re-open it (the reload this issue
    // deletes). The rest of the sentence is unchanged and still exact.
    "After writing your summary, STOP — no further tool calls. Do not re-read files (your skill is inlined above — do not open it), re-run commands or re-scan the diff; the summary is your terminal output.";
  const findingsBranch = lensPromptFor(LENS_SIMPLE, "diff", "ctx", undefined, EVIDENCE_ROSTER);
  const cleanLaneBranch = lensPromptFor(LENS_SECURITY, "diff", "ctx", undefined, EVIDENCE_ROSTER);
  assert(
    findingsBranch.includes(STOP_SENTENCE),
    "#952 canary: findings-expected branch carries the exact stop sentence",
  );
  assert(
    cleanLaneBranch.includes(STOP_SENTENCE),
    "#952 canary: clean-lane (no-findings) branch carries the exact stop sentence",
  );
  // Both branches end with the stop sentence as the final non-blank line.
  const lastLine = (s: string) => [...s.split("\n").reverse()].find((l) => l.trim() !== "") ?? "";
  assert(
    lastLine(findingsBranch) === STOP_SENTENCE,
    "#952 canary: stop sentence is the LAST line of the findings branch",
  );
  assert(
    lastLine(cleanLaneBranch) === STOP_SENTENCE,
    "#952 canary: stop sentence is the LAST line of the clean-lane branch",
  );
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nexit ${failureCount() === 0 ? 0 : 1}`);
process.exit(failureCount() === 0 ? 0 : 1);
