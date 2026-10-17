#!/usr/bin/env bun
/**
 * #1362 round 3 — the cycle-start BASELINE reader, against real git.
 *
 * `readDirtyRootExemptBaseline` is the provenance record the restore claim reads
 * to decide whether a `??` file under an exempt prefix is the cycle's own output
 * or a tool file that was already there. Its whole value is that it errs one way
 * only: recording too little means a claim names a tool file it could have
 * spared; recording too much means the cycle's work goes unmentioned under a
 * claim that says "verified restored". So every path that cannot answer
 * confidently returns `undefined` — "nothing is claim-exempt" — and the tests
 * below pin each of them, alongside the one path that does answer.
 *
 * Real git throughout: the reader parses `git status --porcelain -z -uall`, and
 * a fixture's idea of that format is exactly the thing not being tested.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DIRTY_ROOT_EXEMPT_BASELINE_MAX,
  readDirtyRootExemptBaseline,
} from "../src/work-driver-dirty-root-exempt.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** argv-form exec, matching production's `execp` (never a shell for argv calls). */
const realExec: ExecFn = (cmd, o) =>
  (o?.argv
    ? execFileP(cmd, o.argv, { cwd: o.cwd, maxBuffer: o.maxBuffer })
    : execFileP("/bin/sh", ["-c", cmd], {
        cwd: o?.cwd,
        maxBuffer: o?.maxBuffer,
      })) as ReturnType<ExecFn>;

const root = mkdtempSync(join(tmpdir(), "pi-ens-1362-baseline-"));

/** A fresh single-commit repo with `a.txt` tracked. */
function makeRepo(): { dir: string; g: (args: string[]) => string } {
  const dir = mkdtempSync(join(root, "repo-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "--initial-branch=main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "base"]);
  return { dir, g };
}

try {
  // ---- 1. the ordinary case: the exempt strays, and only those -------------
  {
    const { dir, g } = makeRepo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    mkdirSync(join(dir, ".claude", "nested"), { recursive: true });
    writeFileSync(join(dir, ".claude", "nested", "deep.json"), "{}\n");
    // A tracked file (never a baseline entry — it is not untracked) …
    writeFileSync(join(dir, "a.txt"), "base, edited\n");
    // … and an untracked stray OUTSIDE every exempt prefix.
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", "mine.md"), "mine\n");
    g(["status", "--porcelain", "-uall"]); // warm nothing; just proving git runs

    const baseline = await readDirtyRootExemptBaseline(realExec, dir, [".claude"]);
    assert(
      Array.isArray(baseline) &&
        baseline.length === 2 &&
        baseline.includes(".claude/settings.local.json") &&
        baseline.includes(".claude/nested/deep.json"),
      `baseline lists the pre-existing untracked paths under the exempt prefix, expanded to FILES by -uall (got ${JSON.stringify(baseline)})`,
    );
    assert(
      baseline !== undefined && !baseline.some((p) => p.startsWith("notes/")),
      `baseline never records a path outside the exempt prefixes (got ${JSON.stringify(baseline)})`,
    );
    assert(
      baseline !== undefined && JSON.stringify(baseline) === JSON.stringify([...baseline].sort()),
      `baseline is sorted and stable, so the same tree writes the same state bytes (got ${JSON.stringify(baseline)})`,
    );
    assert(
      baseline !== undefined && new Set(baseline).size === baseline.length,
      "baseline has no duplicates",
    );
  }

  // ---- 2. no exemption list → undefined, and no git call at all ------------
  {
    const { dir } = makeRepo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    let calls = 0;
    const counting: ExecFn = (cmd, o) => {
      calls++;
      return realExec(cmd, o);
    };
    assert(
      (await readDirtyRootExemptBaseline(counting, dir, undefined)) === undefined && calls === 0,
      "no exemption list (undefined) → undefined with NO git call (there is nothing to be exempt)",
    );
    calls = 0;
    assert(
      (await readDirtyRootExemptBaseline(counting, dir, [])) === undefined && calls === 0,
      "an empty exemption list → undefined with NO git call (the no-config path stays free)",
    );
  }

  // ---- 3. nothing under the exempt prefix → an empty baseline --------------
  {
    const { dir } = makeRepo();
    const baseline = await readDirtyRootExemptBaseline(realExec, dir, [".claude", ".vscode"]);
    assert(
      Array.isArray(baseline) && baseline.length === 0,
      `a tree with no exempt paths gives an EMPTY baseline, not undefined (the reader answered, and the answer is "nothing was here") (got ${JSON.stringify(baseline)})`,
    );
  }

  // ---- 4. the cap: too many exempt paths → nothing is claim-exempt ---------
  // Past the cap the field would be a truncated list, and a truncated list
  // silently blesses part of a tree. Recording nothing is the safe direction.
  {
    const { dir } = makeRepo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    for (let i = 0; i < DIRTY_ROOT_EXEMPT_BASELINE_MAX + 2; i++)
      writeFileSync(join(dir, ".claude", `f${i}.json`), "{}\n");
    const over = await readDirtyRootExemptBaseline(realExec, dir, [".claude"]);
    assert(
      over === undefined,
      `more than DIRTY_ROOT_EXEMPT_BASELINE_MAX (${DIRTY_ROOT_EXEMPT_BASELINE_MAX}) exempt paths → the baseline is NOT recorded (fail-closed, not truncated) (got ${JSON.stringify(over)})`,
    );
    // One under the cap still records, which is what proves the check above is
    // the cap firing and not the reader failing for an unrelated reason.
    const { dir: dir2 } = makeRepo();
    mkdirSync(join(dir2, ".claude"), { recursive: true });
    for (let i = 0; i < DIRTY_ROOT_EXEMPT_BASELINE_MAX - 1; i++)
      writeFileSync(join(dir2, ".claude", `f${i}.json`), "{}\n");
    const under = await readDirtyRootExemptBaseline(realExec, dir2, [".claude"]);
    assert(
      Array.isArray(under) && under.length === DIRTY_ROOT_EXEMPT_BASELINE_MAX - 1,
      `just under the cap, the baseline IS recorded in full (got ${under === undefined ? "undefined" : under.length} entries)`,
    );
  }

  // ---- 5. a failed read → undefined (the claim then names everything) -----
  {
    const { dir } = makeRepo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    const failing: ExecFn = () => {
      throw new Error("git status exploded");
    };
    const res = await readDirtyRootExemptBaseline(failing, dir, [".claude"]);
    assert(
      res === undefined,
      `an unreadable status read → undefined, so nothing is claim-exempt rather than everything (got ${JSON.stringify(res)})`,
    );
  }

  // ---- 6. the cap's own boundary value is what the constant says ----------
  assert(
    DIRTY_ROOT_EXEMPT_BASELINE_MAX === 500,
    `the cap is the documented 500 (got ${DIRTY_ROOT_EXEMPT_BASELINE_MAX}) — workflow-state-schema.ts names this constant as the producer's bound`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
