#!/usr/bin/env bun
/**
 * #1114 — the fix pass's fence covers everything the developer leaves in the
 * worktree, not only committed work; an unfenced (N=1, undeclared) workstream
 * is held to the files it already changed plus the files its findings name in
 * those files' directories;
 * and a declared fence's fan-out ceiling is computed from the DECLARED paths.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  devCommit,
  devWrite,
  fixCtx,
  fixState,
  repoWithFile,
  git,
} from "./lib/adversarial-fix-fixtures.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { namedPaths } from "../src/work-driver-adversarial-fix-scope.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

async function runPass(dir: string, st: WorkState, onDev: (d: string) => void) {
  const out = await runAdversarialFixPass(
    fixCtx(dir, onDev),
    st,
    pendingFixes(st.eventLog),
    Date.now(),
  );
  const tail = out.eventLog[out.eventLog.length - 1];
  return {
    applied: tail?.kind === "adversarial-fix-applied",
    parked: tail?.kind === "cap-hit" ? tail.evidence : "",
  };
}

// B7 — an UNCOMMITTED edit outside the fence parks; only committed work used to be checked.
// The developer works in a real separate worktree, as a cycle does.
{
  const dir = repoWithFile("fs-uncommitted");
  const wt = `${dir}-wt`;
  try {
    git(dir, `worktree add -q --detach ${wt} HEAD`);
    const s0 = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const st = { ...s0, pipelineState: { ...s0.pipelineState, worktrees: { default: wt } } };
    const r = await runPass(dir, st, () => {
      devCommit(wt, "a.txt", "two\n");
      devWrite(wt, "b.txt", "stray, uncommitted\n");
    });
    assert(
      !r.applied && r.parked.includes("default changed b.txt"),
      `B7: an uncommitted stray outside the fence parks (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
}

// B8 — an unfenced (N=1, undeclared) pass may touch only what it already
// changed and what its findings name. A third file parks.
{
  const dir = repoWithFile("fs-unfenced");
  try {
    const r = await runPass(dir, fixState(dir, [], "a.txt: change one to two"), (d) =>
      devCommit(d, "b.txt", "two\n"),
    );
    assert(
      !r.applied && r.parked.includes("outside the files it already changed"),
      `B8: an unfenced pass changing an unnamed file parks (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = repoWithFile("fs-unfenced-ok");
  try {
    const st = fixState(dir, [], "a.txt: change one to two");
    // The first develop pass already changed a.txt: that is the anchor a
    // finding-named file in the same directory widens onto (see J below).
    devCommit(dir, "a.txt", "mid\n");
    const r = await runPass(dir, st, (d) => devCommit(d, "a.txt", "two\n"));
    assert(r.applied, "B8: an unfenced pass changing the file its findings name applies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// C2 — the fan-out ceiling is the DECLARED count. One declared path at factor 1
// and minimum 1 allows one file; a finding naming a second file widens the
// fence for the pass but not the ceiling, so changing both parks.
{
  const dir = repoWithFile("fs-fanout");
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "lib", "a.txt"), "one\n");
  writeFileSync(path.join(dir, "lib", "b.txt"), "one\n");
  git(dir, "add -A");
  git(dir, 'commit -q -m "lib"');
  const env = {
    factor: process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR,
    min: process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN,
  };
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  try {
    const r = await runPass(dir, fixState(dir, ["lib/a.txt"], "lib/a.txt: one; lib/b.txt: also"), (d) => {
      writeFileSync(`${d}/lib/a.txt`, "two\n");
      writeFileSync(`${d}/lib/b.txt`, "two\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked.includes("fan-out limit 1 for its 1 declared path"),
      `C2: the fan-out ceiling counts declared paths only (got "${r.parked}")`,
    );
  } finally {
    for (const [k, v] of [
      ["PI_ENSEMBLE_SCOPE_FANOUT_FACTOR", env.factor],
      ["PI_ENSEMBLE_SCOPE_FANOUT_MIN", env.min],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// B9 — a rename lists both sides. A pass that moves an undeclared file onto a
// declared path names the deleted source too, so the move parks.
{
  const dir = repoWithFile("fs-rename");
  try {
    mkdirSync(path.join(dir, "other"), { recursive: true });
    writeFileSync(path.join(dir, "other", "x.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "other"');
    const r = await runPass(dir, fixState(dir, ["lib/a.ts"], "lib/a.ts: fix it"), (d) => {
      mkdirSync(path.join(d, "lib"), { recursive: true });
      git(d, "mv other/x.ts lib/a.ts");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked.includes("other/x.ts"),
      `B9: a rename from an undeclared file onto a declared path parks (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// J — the widening rule is directory-scoped and generic (no project list). A
// finding-named path widens only when it shares a directory with a declared
// path or a file the workstream already changed.
{
  // J1 — a verifier module in another directory does not widen; the change parks.
  const dir = repoWithFile("fs-other-dir");
  try {
    mkdirSync(path.join(dir, "lib"), { recursive: true });
    writeFileSync(path.join(dir, "lib", "verify.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "verifier"');
    const st = fixState(dir, ["extension/src/a.ts"], "lib/verify.ts: fix the check");
    const r = await runPass(dir, st, (d) => {
      writeFileSync(path.join(d, "lib", "verify.ts"), "export const v = 2;\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked.includes("lib/verify.ts"),
      `J1: a finding naming a file in another directory does not widen the fence (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // J2 — a file in the declared file's directory widens and the pass applies.
  const dir = repoWithFile("fs-same-dir");
  try {
    mkdirSync(path.join(dir, "lib"), { recursive: true });
    writeFileSync(path.join(dir, "lib", "parse.ts"), "export {};\n");
    writeFileSync(path.join(dir, "lib", "check.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "lib"');
    const st = fixState(dir, ["lib/parse.ts"], "lib/parse.ts: fix; lib/check.ts: also");
    const r = await runPass(dir, st, (d) => {
      writeFileSync(path.join(d, "lib", "parse.ts"), "export const p = 2;\n");
      writeFileSync(path.join(d, "lib", "check.ts"), "export const c = 2;\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      r.applied,
      `J2: a finding naming a same-directory file widens the fence (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // J3 — the repo root is not an anchor: a root file named by a finding does
  // not widen a root-declared fence, so the install.sh change parks.
  const dir = repoWithFile("fs-install");
  try {
    writeFileSync(path.join(dir, "install.sh"), "#!/bin/sh\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "install"');
    const st = fixState(dir, ["a.txt"], "a.txt: fix; install.sh: and this");
    const r = await runPass(dir, st, (d) => {
      writeFileSync(path.join(d, "a.txt"), "two\n");
      writeFileSync(path.join(d, "install.sh"), "#!/bin/sh\necho two\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked.includes("install.sh"),
      `J3: a root file named by a finding does not widen a root-declared fence (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// L — a declared `./`-prefixed path is normalised: a change to the file it
// names is inside the fence (no false park).
{
  const dir = repoWithFile("fs-dot-slash");
  try {
    const r = await runPass(dir, fixState(dir, ["./a.txt"], "a.txt: change one to two"), (d) =>
      devCommit(d, "a.txt", "two\n"),
    );
    assert(r.applied, `L: a ./-declared path fences the file it names (got "${r.parked}")`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// K — driver-owned modules are never widened onto, even in the declared directory.
{
  const tracked = [
    "extension/src/x.ts",
    "extension/src/y.ts",
    "extension/src/work-driver-verify-cmd.ts",
    "extension/src/adversarial-verdict.ts",
    "extension/src/comment-evidence.ts",
  ];
  const named = namedPaths(
    "extension/src/work-driver-verify-cmd.ts extension/src/adversarial-verdict.ts extension/src/comment-evidence.ts extension/src/y.ts",
    tracked,
    ["extension/src/x.ts"],
  );
  assert(
    named.join(",") === "extension/src/y.ts",
    `K: a finding naming a driver-owned module does not widen the fence (got ${named.join(",")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
