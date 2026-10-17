#!/usr/bin/env bun
/**
 * Path claims grounded by existence — against a REAL git repo, at the branch ref.
 *
 * `test-claim-scan.ts` covers the rule with injected fakes. This file exists
 * because a fake cannot prove the two things that actually broke in the field
 * (#1002, from /work 994's eight MEDIUM findings against six skills):
 *
 *   1. **The probe runs at `origin/<branch>`, not on disk.** The lens children's
 *      worktree stays detached at `baseSha`, so a `references/` file the PR
 *      itself added is not on the filesystem at all. A fix that asked the disk
 *      would have failed on exactly the case it was written for — the six
 *      findings were findings about files the PR had just added.
 *   2. **Both resolutions are tried, and either one existing is enough.** Pi
 *      documents skill files as "relative paths from the skill directory", so
 *      `references/patterns.md` cited from `skill/go-idiomatic/SKILL.md` means
 *      `skill/go-idiomatic/references/patterns.md`; but a doc citing
 *      `docs/runbook.md` from a subdirectory means the repo-root file. A rule
 *      that tried only one of the two is wrong half the time, and the half it
 *      gets wrong is the half that generates findings.
 *
 * Everything here is a `git` subprocess against a `mkdtemp` repo, so it is
 * offline and free, but it is the first test in this area with a filesystem.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "../src/exec.ts";
import { runClaimScan } from "../src/lens-evidence.ts";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claim-scan-paths-"));

/**
 * A repo whose `origin/feature/x` adds a SKILL.md citing `references/x.md`, and
 * whose CHECKOUT is then rewound to the base commit — the state a lens child's
 * `cwd` is in under always-worktree.
 *
 * `files` decides which reference files the branch actually carries, which is
 * the only knob the assertions turn.
 */
let n = 0;
async function buildRepo(files: Record<string, string>): Promise<{ repo: string; diff: string }> {
  n++;
  const origin = path.join(tmp, `origin-${n}.git`);
  const repo = path.join(tmp, `repo-${n}`);
  await fs.mkdir(repo, { recursive: true });
  await sh(`git init -q --bare "${origin}"`, tmp);
  await sh(
    `git init -q && git config user.email t@t && git config user.name t && git remote add origin "${origin}"`,
    repo,
  );

  await fs.writeFile(path.join(repo, "README.md"), "# fixture\n");
  await sh("git add -A && git commit -q -m base && git push -q origin HEAD:main", repo);
  const baseSha = (await sh("git rev-parse HEAD", repo)).trim();

  await sh("git checkout -q -b feature/x", repo);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), content);
  }
  await sh("git add -A && git commit -q -m branch && git push -q origin feature/x", repo);

  // Rewind the checkout: what a detached lens worktree would see.
  await sh(`git checkout -q ${baseSha}`, repo);

  const { stdout } = await execFileAsync("git", ["diff", "origin/main...origin/feature/x"], {
    cwd: repo,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { repo, diff: stdout };
}

const SKILL_BODY = "# Go Skill\n\nRead `references/patterns.md` before writing any of this.\n";

// ------------------------------------ the #994 shape: exists at the branch ref

{
  const { repo, diff } = await buildRepo({
    "skill/go-idiomatic/SKILL.md": SKILL_BODY,
    "skill/go-idiomatic/references/patterns.md": "# Patterns\n\nDo not use exceptions.\n",
  });

  // Canary first: if the checkout were not rewound, a filesystem check would
  // pass for the wrong reason and every assertion below would be worthless.
  const onDisk = await fs
    .readFile(path.join(repo, "skill/go-idiomatic/references/patterns.md"), "utf8")
    .catch(() => undefined);
  assert(
    onDisk === undefined,
    "canary: the cited file is NOT on the worktree — the branch is the only place it exists",
  );

  const findings = await runClaimScan(execp, repo, "feature/x", diff);
  assert(
    findings.length === 0,
    "a SKILL.md citing references/patterns.md that exists at origin/<branch> produces ZERO findings — the eight #994 false positives",
  );
}

// ------------------------------------- not vacuous: invented reference still fires

{
  const { repo, diff } = await buildRepo({
    "skill/go-idiomatic/SKILL.md": SKILL_BODY,
    // ...and no references/patterns.md anywhere on the branch.
  });

  const findings = await runClaimScan(execp, repo, "feature/x", diff);
  const titles = findings.map((f) => f.title);
  assert(
    titles.some((t) => /Unsourced path: references\/patterns\.md/.test(t)),
    "a SKILL.md citing a references/ file the branch does NOT have is still an 'Unsourced path' finding",
  );
  assert(
    findings.every((f) => f.severity === "MEDIUM"),
    "...at MEDIUM, unchanged — this fix does not soften severities",
  );
}

// ------------------------- root-relative resolution, from a file in a subdirectory

{
  // README.md sits at the repo root, so `docs/runbook.md` resolves against the
  // root — asserting-dir-relative would look for `docs/docs/runbook.md` and
  // find nothing. Either resolution grounding is the whole rule.
  const { repo, diff } = await buildRepo({
    "app/NOTES.md": "# Notes\n\nDeploy per `docs/runbook.md` and skip `docs/absent.md`.\n",
    "docs/runbook.md": "# Runbook\n\nRoll forward, never back.\n",
  });

  const findings = await runClaimScan(execp, repo, "feature/x", diff);
  const titles = findings.map((f) => f.title);
  assert(
    !titles.some((t) => t.includes("docs/runbook.md")),
    "a path that exists at the REPO ROOT grounds a claim made from a subdirectory",
  );
  assert(
    titles.some((t) => t.includes("docs/absent.md")),
    "...while a sibling path in the SAME line that exists nowhere still fires (not vacuous)",
  );
}

// ------------------------------- path existence never rescues a non-path claim

{
  // The out-of-scope half of the ticket, asserted rather than assumed: the
  // "Serverless v2" product claim is described only in prose, and the fix must
  // leave it a finding even though the file named beside it exists.
  const { repo, diff } = await buildRepo({
    "skill/postgres-database/SKILL.md":
      "# Postgres\n\nRead `references/aurora-aws.md` for Aurora Serverless v2.\n",
    "skill/postgres-database/references/aurora-aws.md":
      "# Aurora\n\nAurora Serverless v2 scales.\n",
  });

  const findings = await runClaimScan(execp, repo, "feature/x", diff);
  const titles = findings.map((f) => f.title);
  assert(
    !titles.some((t) => t.includes("references/aurora-aws.md")),
    "the golden #994 pair grounds its path claim on the real tree",
  );
  assert(
    titles.some((t) => /Unsourced product: Serverless v2/.test(t)),
    "and the product claim beside it is untouched — 'prose does not ground prose' survives for non-path kinds",
  );
}

// ------------------------------------------- an unsafe token never reaches git

{
  // `..` is the traversal shape. It must not be interpolated into a tree-ish,
  // and it must not crash the scan — an unusable token is simply "not grounded
  // by existence", which is the same answer as absence.
  const { repo, diff } = await buildRepo({
    "docs/x.md": "# X\n\nSee `../../../etc/passwd.md` and `../outside/foo.md`.\n",
  });

  const findings = await runClaimScan(execp, repo, "feature/x", diff);
  const titles = findings.map((f) => f.title);
  assert(
    titles.some((t) => t.includes("../outside/foo.md")),
    "a `..` path token stays an ordinary ungrounded path claim rather than escaping the repo",
  );
  assert(
    findings.length > 0,
    "the scan completes on an unsafe token instead of throwing or hanging",
  );
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
