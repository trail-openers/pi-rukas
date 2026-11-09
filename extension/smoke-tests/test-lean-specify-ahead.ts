#!/usr/bin/env bun
/**
 * lean/specify, part 6 — the retry re-prepares a worktree its own child moved.
 *
 * The failure this pins: attempt 1's child commits a file on the run's branch
 * (policy allows a child to commit in its assigned worktree), the attempt ends
 * retryable — a submitted row the boundary dropped — and the step comes back to
 * `prepareTree` a second time. That second prepare ran the ownership gate, which
 * demanded HEAD equal the base, and so refused the very tree whose next statement
 * resets it to the base. The hand-back read `could not prepare the worktree …:
 * the directory … is not a worktree of this repository … (its HEAD is <child
 * commit>, expected <base>)` and the run exited 10 with no tests frozen.
 *
 * The case is the field shape end to end: a real repo, a real child commit on the
 * run's branch, the real retry path, and an outcome that must be a verdict rather
 * than an infra throw. The predicate itself is unit-tested directly in
 * test-lean-specify-ownership.ts.
 *
 * The fixture is lib/lean-specify-fixture.ts.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_TEST_LINES } from "../src/lean/test-size.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  git,
  makeRepo,
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

const CONFIG = configWith({ fast: "true", test: RUNNER });
const TEST_REL = "tests/AC1-retry.test.sh";
/** One line past the size cap, so attempt 1's submission is dropped at the boundary. */
function oversize(): string {
  return `${Array.from({ length: MAX_TEST_LINES + 1 }, (_, i) => `# line ${i}`).join("\n")}\n`;
}

function writeTest(wt: string, body: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), body, { mode: 0o755 });
}

// ── (a) attempt 1's child commits; the retry re-prepares the tree it moved
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  let n = 0;
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 41,
    config: CONFIG,
    writes: (wt) => {
      n++;
      if (n === 1) {
        // The child's own work, and its own commit of it on the run's branch —
        // what the adversary is allowed to do, and what the gate then refused.
        writeTest(wt, oversize());
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "child: my own test");
        return;
      }
      writeTest(wt, redScript());
    },
    toolUses: () => [submit("AC1", [TEST_REL])],
  });
  // THE regression assertion: pre-fix this throw carried the ownership text, and
  // the step handed back as infrastructure instead of reaching a verdict.
  assert(
    r.threw === undefined || !/does not own/.test(r.threw.message),
    `(a) the retry's prepare did not refuse a tree its own child moved ahead of the base (got ${r.threw?.message})`,
  );
  assert(r.threw === undefined, `(a) no infra handback: ${r.threw?.message ?? "clean"}`);
  assert(r.dispatched === 2, `(a) the adversary ran twice (got ${r.dispatched})`);
  assert(r.outcome?.kind === "ok", `(a) the retry's red test is ok (got ${r.outcome?.kind})`);
  assert(
    git(r.worktree, "rev-parse", "HEAD^") === baseSha,
    "(a) the retry reset the tree back to the base before its own commit",
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === TEST_REL,
    `(a) the frozen file is the retry's (got ${Object.keys(r.outcome?.frozen ?? {}).join()})`,
  );
}

// ── (b) a tree at that path this run does not own still hands back, unmutated
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  // A directory someone else made at the step's worktree path: a git repository
  // of its own, registered nowhere. The step must throw BEFORE the reset that
  // would have destroyed it, and the dispatch must never be paid for.
  const wt = path.join(repoRoot, ".worktrees", "lean-42");
  mkdirSync(path.join(wt, "somebody-elses-project"), { recursive: true });
  writeFileSync(path.join(wt, "somebody-elses-project", "keep.ts"), "PRECIOUS\n");
  git(wt, "init", "-q", "-b", "main");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "somebody else's base");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 42,
    config: CONFIG,
    writes: () => {},
    toolUses: () => [submit("AC1", [TEST_REL])],
  });
  assert(
    r.threw !== undefined && /does not own/.test(r.threw.message),
    `(b) an unregistered tree at the lean path hands back as an ownership refusal (got ${r.threw?.message ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(r.dispatched === 0, `(b) no adversary was spent (got ${r.dispatched})`);
  assert(
    existsSync(path.join(wt, "somebody-elses-project", "keep.ts")),
    "(b) the foreign tree was left exactly as found",
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
