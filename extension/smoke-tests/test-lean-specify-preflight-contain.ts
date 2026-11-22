#!/usr/bin/env bun
/**
 * lean/specify — the probe's parent directory is containment-checked (#2202).
 *
 * `verify.testDir` is validated as a SHAPE — repo-relative, no wildcard, not
 * hidden. A shape cannot say whether the directory the base committed is a
 * directory of THIS checkout, and `writeFileSync(…, { flag: "wx" })` happily writes
 * through a symlinked parent: the probe's bytes land outside the worktree, in a
 * tree this step has no claim on, and the run reports a healthy runner.
 *
 * So the probe's parent is resolved with `realpath` and must lie inside
 * `realpath(worktree)`. Three arms, one case each, and the outside target is
 * checked as bytes rather than as a path — "we did not write there" is only
 * evidence if it is read:
 *
 *   (c1) a base-committed `tests` that is a symlink OUT of the worktree never
 *        receives the probe: nothing appears at the target, the run proceeds, and
 *        the probe sits at the worktree root instead;
 *   (c2) the same repo with `PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN=0` is the
 *        control that makes (c1) about the check rather than about a stub that
 *        never writes: with the switch off, the bytes DO land outside;
 *   (c3) a configured folder whose PARENT segment is the link is refused the same
 *        way, and the fallback root is itself containment-checked — a worktree
 *        whose own root cannot be resolved hands back naming the reason rather than
 *        writing wherever the config pointed.
 *
 * The real-pytest claims are in `test-lean-preflight-real-pytest.ts`; the probe's
 * name and its exit-status reading are in `test-lean-specify-preflight-py.ts`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  PROBE,
  PY_PROBE,
  exists,
  probeDir,
  runner,
  runPreflight,
} from "./lib/lean-preflight-probe-fixture.ts";
import { ROOTS } from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The bytes a probe write would put at the outside target, if it wrote at all. */
const CANARY = "the containment check must keep these bytes OUT of this file\n";

/**
 * A temp repo whose `tests` (or `tests`' parent) is a symlink to `outside`, with a
 * runner that is healthy on either probe shape so the placement — not the runner —
 * decides where the file lands.
 *
 * `linkParent` links `nested` (so `nested/tests` resolves outside the tree) and
 * otherwise links `tests` itself. Both are committed, because a link the step made
 * moments earlier is not the base-carried shape the case is about.
 */
function linked(dir: string, outside: string, linkParent: boolean): string {
  if (linkParent) {
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    symlinkSync(outside, path.join(dir, "nested", "tests"));
    return "nested/tests";
  }
  symlinkSync(outside, path.join(dir, "tests"));
  return "tests";
}

// ── (c1) + (c2): the outside target is untouched with the check on, written with it off
{
  // One repo, two arms, so the two runs differ ONLY in the variable. The stub
  // reports on whatever it is handed and exits 5, which is the healthy answer: the
  // probe's PATH is the only thing these two runs can be about. The `victim` name
  // is the one the probe WOULD have at the target — `outside/_lean_runner_probe.py`
  // — so a write that followed the link lands exactly there and nothing else can
  // create the file this case reads.
  const dir = probeDir("lean-contain-");
  rmSync(path.join(dir, "tests"), { recursive: true, force: true });
  const outside = probeDir("lean-contain-outside-");
  // The name the probe carries, wherever it lands: at the target through the link,
  // or at the worktree root. Both are read, because "nothing was written outside"
  // is only evidence when both spellings of it are checked.
  const victim = path.join(outside, PY_PROBE);
  // The stub is a witness, not a no-op: it appends the path it was handed to a
  // sidecar the case reads afterwards. A probe written through the link is a file
  // the RUNNER opened, and that is the fact the control arm has to establish.
  const sidecar = path.join(dir, "witness-on.log");
  const template = runner(
    dir,
    "ok.sh",
    `echo "$1" >> ${JSON.stringify(sidecar)}`,
    "[ -e \"$1\" ] || exit 7",
    "exit 5",
  );
  const testDir = linked(dir, outside, false);
  const loc = { testDirs: [testDir], testGlob: "test_*.py" };

  const on = await runPreflight({ wt: dir, template, testLocation: loc });
  // With the check on, the runner's own log names the ROOT path and never the
  // linked one — the witness is read on both arms for the same reason.
  const onLog = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : "";
  assert(
    onLog.includes(PROBE) && !onLog.includes(`${testDir}/`),
    `(c1) and the runner only ever saw the root path (log: ${onLog.trim()})`,
  );
  assert(on.threw === undefined, `(c1) a symlinked testDir is not a hand-back (${on.threw?.message})`);
  // The root's own probe name: the fall-back is the root path, and the root's
  // probe is the hidden dotfile. What matters is WHERE the bytes went, and the
  // argv names it.
  assert(
    on.written[0] === PROBE,
    `(c1) the probe fell back to the worktree root (got ${on.written[0] ?? "<nothing run>"})`,
  );
  assert(
    !existsSync(victim) && !existsSync(path.join(outside, PROBE)),
    "(c1) and the target OUTSIDE the worktree received no probe file on either name",
  );

  // The control: the same repo, the same runner, the switch at 0. Without this the
  // "nothing outside was touched" assertion would also pass on a step that never
  // writes probes at all.
  const offSidecar = path.join(dir, "witness-off.log");
  const offTemplate = runner(
    dir,
    "okoff.sh",
    `echo "$1" >> ${JSON.stringify(offSidecar)}`,
    "[ -e \"$1\" ] || exit 7",
    "exit 5",
  );
  await withEnv({ PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN: "0" }, async () => {
    const off = await runPreflight({ wt: dir, template: offTemplate, testLocation: loc });
    assert(
      off.threw === undefined,
      `(c2) with the check off the step writes where the config points (${off.threw?.message})`,
    );
    assert(
      off.written[0] === `tests/${PY_PROBE}`,
      `(c2) and the probe path names the linked folder (got ${off.written[0] ?? "<nothing run>"})`,
    );
    // The write went THROUGH the link: the file now exists in `outside`, which is
    // outside both the repo and the step's claim on it. Read the TARGET, not the
    // link — they are the same inode, and only the outside name can show the bytes
    // left the tree.
    assert(
      // The runner's own witness: the stub records every file it is handed that it
      // can `test -e`, so a probe whose write went THROUGH the link is reported by
      // the process that read it, at the moment it existed. The probe is unlinked
      // afterwards, so this — not a post-hoc `existsSync` — is the evidence.
      existsSync(offSidecar) && readFileSync(offSidecar, "utf8").includes(`${testDir}/${PY_PROBE}`),
      `(c2) control: with the check off the runner really read the probe at the linked path — so (c1) is about the check (saw ${existsSync(offSidecar) ? readFileSync(offSidecar, "utf8").trim() : "<no witness>"})`,
    );
  });
}

// ── (c3) the fallback root is containment-checked too, and says so
{
  // A link at the PARENT segment is the same hole one level up: `nested/tests`
  // resolves outside, and the fallback must not be "write to the config's path
  // anyway". Here the root is a real directory, so the probe lands there.
  const dir = probeDir("lean-contain-nested-");
  rmSync(path.join(dir, "tests"), { recursive: true, force: true });
  const outside = probeDir("lean-contain-nested-outside-");
  const template = runner(dir, "ok.sh", "exit 5");
  const testDir = linked(dir, outside, true);
  const got = await runPreflight({
    wt: dir,
    template,
    testLocation: { testDirs: [testDir], testGlob: "test_*.py" },
  });
  assert(
    got.threw === undefined && got.written[0] === PROBE,
    `(c3) a linked parent segment falls back to the root too (got ${got.written[0] ?? got.threw?.message})`,
  );
  assert(
    !exists(dir, `nested/tests/${PY_PROBE}`) && !existsSync(path.join(outside, PY_PROBE)),
    "(c3) and nothing was written through the link, at either end of it",
  );

  // A worktree that is itself a symlink resolves to a real root, so containment
  // holds through a linked WORKTREE (the driver's own `.worktrees/` shape) — the
  // check must not refuse a legitimate tree and hand back every lean run.
  const outer = probeDir("lean-contain-wtlink-");
  const realWt = path.join(outer, "real");
  mkdirSync(path.join(realWt, "tests"), { recursive: true });
  const linkedWt = path.join(outer, "linked");
  symlinkSync(realWt, linkedWt);
  const linkedTemplate = runner(realWt, "ok.sh", "exit 5");
  const viaLink = await runPreflight({
    wt: linkedWt,
    template: linkedTemplate,
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
  });
  assert(
    viaLink.threw === undefined && viaLink.written[0] === `tests/${PY_PROBE}`,
    `(c3) a symlinked worktree still probes inside itself (got ${viaLink.written[0] ?? viaLink.threw?.message})`,
  );
  // A worktree whose own root cannot be resolved is the one case with nowhere safe
  // to put the probe: it hands back naming the reason instead of writing wherever
  // the config pointed. `realpathSync` answers "" for a name that is not on the
  // filesystem at all, which is the shape that stand-in gives.
  const missing = await runPreflight({
    wt: path.join(outer, "not-a-tree"),
    template: "sh ok.sh {file}",
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
  });
  assert(
    missing.threw instanceof Error &&
      /could not place its probe inside the worktree/.test(missing.threw.message),
    `(c3) a worktree whose root cannot be resolved hands back naming the reason (got ${
      missing.threw?.message ?? "no throw"
    })`,
  );
  assert(
    missing.written.length === 0,
    `(c3) and the runner was never asked about a probe that was never written (got ${missing.written.length} calls)`,
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
