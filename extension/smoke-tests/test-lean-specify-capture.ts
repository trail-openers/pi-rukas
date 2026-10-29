#!/usr/bin/env bun
/**
 * lean/specify, part 6 — the CAPTURE window: a link swapped in AFTER the step
 * has validated a submitted path.
 *
 * `fileProblem` is a fact about a NAME, checked before the read, and the child
 * writes the file and submits its path from its own side of the step — so it
 * has a window between the two. Cases (h) and (i) plant a hard link and a
 * symlink while the child is still working, and the path checks refuse them;
 * these two plant the SAME artefact in the window after validation, where only
 * the capture's own single pinned descriptor (`O_RDONLY | O_NOFOLLOW`, `fstat`
 * before and after the read, `nlink === 1`) can see it. Both must drop the row
 * with its reason and commit nothing, so the bytes of a file outside the
 * worktree are never frozen, hashed, or pushed.
 *
 * The swap is placed through the fixture's `capture` hook, which runs the case's
 * own write BEFORE the real read — the step's own `afterCapture` fires after
 * it, which would be too late to be the case.
 *
 * The fixture is lib/lean-specify-fixture.ts.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { captureTestBytes } from "../src/lean/specify-capture.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  git,
  makeRepo,
  outsideDir,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------- (p) a hard link swapped in AFTER validation is never captured
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // Case (h) plants the hard link while the child is still working, so the
  // path check refuses it. This is the harder case: the file is a genuine
  // ordinary file when the step validates it, and the link appears only in the
  // window between validation and the read. `readFileSync` would have followed
  // the name and frozen somebody else's bytes; one pinned descriptor sees the
  // swap through its link count and drops the row.
  const outside = outsideDir();
  const secret = path.join(outside, "swapped-in.ts");
  writeFileSync(secret, "SECRET OUTSIDE BYTES\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 15,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-swap.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-swap.test.sh"])],
    // The swap happens in the window the case is about: the step has validated
    // the path and holds the fd-less `lstat` answer, and the read that follows
    // is where the pinned descriptor has to catch it. The hook runs after the
    // read, so the capture is wrapped here instead.
    capture: (wt, paths, owners) => {
      const target = path.join(wt, "tests/AC1-swap.test.sh");
      unlinkSync(target);
      linkSync(secret, target);
      return captureTestBytes(wt, paths, owners);
    },
  });
  assert(r.threw === undefined, `(p) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "no-red-test", `(p) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.reason ?? "").includes("hard link"),
    `(p) the reason says why: a hard link at capture (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.frozen === undefined || Object.keys(r.outcome.frozen).length === 0,
    "(p) nothing is frozen from a swapped-in hard link",
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD") === baseSha,
    "(p) nothing was committed on top of the base",
  );
  assert(
    git(r.worktree, "log", "--format=%s").trim() === "base",
    "(p) the worktree carries no driver commit at all",
  );
  assert(existsSync(secret), "(p) the outside file is untouched");
}

// ------------------ (q) a symlink swapped in AFTER validation is never captured
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const outside = outsideDir();
  const target = path.join(outside, "elsewhere-swap.ts");
  writeFileSync(target, "#!/bin/sh\necho SECRET\nexit 1\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 16,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-swaplink.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-swaplink.test.sh"])],
    capture: (wt, paths, owners) => {
      const file = path.join(wt, "tests/AC1-swaplink.test.sh");
      unlinkSync(file);
      symlinkSync(target, file);
      return captureTestBytes(wt, paths, owners);
    },
  });
  assert(r.threw === undefined, `(q) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "no-red-test", `(q) no-red-test, got ${r.outcome?.kind}`);
  assert(
    /could not be opened/.test(r.outcome?.reason ?? ""),
    `(q) the reason says the file could not be opened through O_NOFOLLOW (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.frozen === undefined || Object.keys(r.outcome.frozen).length === 0,
    "(q) nothing is frozen from a swapped-in symlink",
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD") === baseSha,
    "(q) nothing was committed, so the outside bytes were never committed",
  );
  assert(
    git(r.worktree, "status", "--porcelain", "-uall") === "",
    "(q) and the worktree is clean — the link did not survive either",
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
