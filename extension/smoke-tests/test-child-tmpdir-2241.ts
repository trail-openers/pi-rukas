#!/usr/bin/env bun
/**
 * #2241 — each child's TMPDIR (and TMP, TEMP) is its own per-spawn dir.
 *
 * Before this change a child inherited the parent's `TMPDIR`, so its `mktemp`,
 * its fixtures and its bun scratch landed in the SHARED temp root — while the
 * deletion rule (#2200) lets a child remove only inside its worktree, its
 * scratch dir and its own per-spawn temp dir. The child could clean up nothing
 * it had made, and what it leaked went into the root every other run shares.
 *
 * Four observations, in order:
 *   1. the real `spawnSpecialist` hands its child TMPDIR, TMP and TEMP equal to
 *      `PI_ENSEMBLE_CHILD_TMP` — and an inherited value from the parent does not
 *      win (T1: the assignments sit after the last write to `childEnv`);
 *   2. the per-spawn dir is `0700` (T2) — `mkdtemp`'s mode is umask-inherited,
 *      so the explicit `chmod` is what the #2051 harness skip depends on;
 *   3. judged under that child env, a LITERAL delete inside the child's own dir
 *      runs while a literal delete of the shared temp root is refused (T6: the
 *      rule refuses any `$`-expanded word before judging roots, so both rows
 *      spell their paths out — there is no `$TMPDIR` spelling);
 *   4. a nested dispatch made inside a child resolves the host spawn-slot dir to
 *      its PARENT'S path (T4), and still gets its own `PI_ENSEMBLE_CHILD_TMP`.
 *
 * No Pi binary, no model, no tokens: the child is a `/bin/sh` stub that dumps
 * its env (the same seam `test-inherited-repo-env.ts` uses).
 */

// Must stay first: points the role prompts at a test-owned dir before src/roles.ts
// resolves them at module load (#1579, same helper as test-cancel.ts).
import "./lib/cancel-prompts.ts";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { dispatchCore } from "../src/dispatch.ts";
import { hostSpawnDir } from "../src/host-spawn-slots.ts";
import { childEnvFor } from "../src/write-fence-contract.ts";
import {
  CHILD_TMP_ENV,
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import { withEnv } from "./lib/env-scope.ts";
import { buildDeletionFixture, withDeletionHost } from "./lib/write-fence-deletion-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scratch = mkdtempSync(path.join(os.tmpdir(), "pi-2241-"));
process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";

/** Spawn one stub child and return the env it actually ran with. */
async function childEnvOf(tag: string, parentEnv: Record<string, string>): Promise<string> {
  const envFile = path.join(scratch, `${tag}.env`);
  const stub = path.join(scratch, `${tag}.sh`);
  // Leftovers from an earlier run of the same tag would satisfy the "gone" rows
  // with a stale file, so each run starts from nothing.
  rmSync(envFile, { force: true });
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      '[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }',
      // Scratch the child makes under the TMPDIR it was handed: the spawn's
      // cleanup must remove it, which is the point of the change.
      `: > "$TMPDIR/child-scratch.txt" 2>/dev/null`,
      // The child reads its own TMPDIR's mode and lists it — both observable
      // only while the spawn's `finally` has not removed the dir yet. Its
      // stdout is the child's JSONL channel and the parent captures it, so
      // these lines are appended to the env dump the assertions read.
      `echo "MODE=$(stat -c '%a' "$TMPDIR" 2>/dev/null)" >> ${envFile}`,
      `echo "PROMPT=$(ls -A "$TMPDIR" 2>/dev/null | tr '\n' ' ')" >> ${envFile}`,
      `env >> ${envFile}`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  let out = "";
  await withEnv({ ...parentEnv, PI_ENSEMBLE_PI_BIN: stub }, async () => {
    const host: DispatchHost = { sendUserMessage: () => {} };
    const done = dispatchCore(host, { role: "developer", prompt: "stub" }, { skipDeck: true });
    // The child creates the file at the START of its run (no `env` yet), so the
    // poll waits for the file to STOP GROWING — the dump is complete once one
    // interval passes with the same size, and the dispatch's own exit race is
    // what guarantees the file is no longer being appended to.
    let size = -1;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const now = existsSync(envFile) ? statSync(envFile).size : -1;
      if (now === size && now > 0) break;
      size = now;
      await sleep(50);
    }
    await Promise.race([done.catch(() => undefined), sleep(10_000)]);
  });
  if (existsSync(envFile)) out = readFileSync(envFile, "utf8");
  return out;
}

// ── 1 + 2: the real spawn hands the child its own temp root, at 0700 ────────
{
  // A poisoned inherited temp root: the whole point is that it must NOT win.
  const inherited = path.join(scratch, "inherited-shared-tmp");
  writeFileSync(path.join(scratch, "sentinel.txt"), "x");
  const env = await childEnvOf("child", { TMPDIR: inherited, TMP: inherited, TEMP: inherited });
  assert(/^GIT_EDITOR=true$/m.test(env), "the stub child ran and recorded its env");
  const line = (name: string) => env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
  const childTmp = line(CHILD_TMP_ENV);
  assert(childTmp !== undefined && childTmp !== "", `the child carries ${CHILD_TMP_ENV}`);
  // The mode the child itself read from its own TMPDIR while it was alive.
  const liveMode = Number.parseInt(env.match(/^MODE=([0-7]+)$/m)?.[1] ?? "", 8);
  const liveList = env.match(/^PROMPT=(.*)$/m)?.[1] ?? "";
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    assert(
      line(name) !== undefined && line(name) === childTmp,
      `the child's ${name} is its own per-spawn dir, not the inherited one (got ${JSON.stringify(line(name))})`,
    );
  }
  assert(line("TMPDIR") !== inherited, "an inherited TMPDIR does not win over the per-spawn dir");
  // `fs.chmod` is NOT the whole mode story: on a filesystem that ignores the
  // mode bits (a permissive mount, an overlay) the call succeeds and the mode
  // stays wide. Read it BACK, and read it from the LIVE child below — the
  // spawn's `finally` removes this dir when the dispatch ends, so the parent
  // cannot stat it afterwards.
  assert(
    liveMode === 0o700,
    `the child sees its own TMPDIR as 0700 (got ${(liveMode ?? -1).toString(8)})`,
  );
  assert(
    childTmp?.startsWith(`${os.tmpdir()}${path.sep}`) === true,
    `the per-spawn dir still lives under the PARENT's temp root (got ${childTmp})`,
  );
  assert(
    liveList.split(/\s+/).includes("developer.md"),
    `the same dir still holds the child's role prompt — one dir, both jobs (the child listed ${JSON.stringify(liveList)})`,
  );
  // The spawn's finally owns the cleanup: the dir the child wrote into is gone
  // once the dispatch ends, so #2241 adds nothing new for anyone to sweep.
  assert(
    childTmp !== undefined && !existsSync(childTmp),
    "the spawn's existing cleanup removed the dir the child wrote into",
  );
}

// ── 3: the child env's own temp root is deletable, the shared root is not ───
{
  const fx = buildDeletionFixture("tmpdir-2241");
  await withDeletionHost({ HOME: fx.base, TMPDIR: fx.sharedTmp }, async () => {
    // The env a repointed child really runs with: its TMPDIR spellings all name
    // the per-spawn dir, which is also its CHILD_TMP.
    const childEnv = {
      [CHILD_TMP_ENV]: fx.childTmp,
      TMPDIR: fx.childTmp,
      TMP: fx.childTmp,
      TEMP: fx.childTmp,
    };
    const roots = deletionRootsFrom(childEnv, fx.wt);
    // Literal paths, never `$TMPDIR` (T6): the rule refuses any `$`-expanded
    // word at a delete position before it judges roots at all.
    const own = `${fx.childTmp}/probe-scratch`;
    const shared = `${fx.sharedTmp}/other-session-run`;
    assert(
      firstDeletionOutside(`rm -rf ${own}`, roots) === undefined,
      "the child's own temp root is deletable by a literal path spelled out",
    );
    assert(
      firstDeletionOutside(`rm -rf ${shared}`, roots) !== undefined,
      "the shared temp root is still refused by a literal path spelled out",
    );
    // The `$` form stays refused on BOTH sides — the rule never expands it.
    assert(
      firstDeletionOutside('rm -rf "$TMPDIR/probe-scratch"', roots) !== undefined,
      "an expansion is refused even when it names the child's own dir (the rule reads commands, not the shell's values)",
    );
  });
}

// ── 4: a nested dispatch inside a child keeps the host-wide shared trees ────
{
  const slots = path.join(scratch, "shared-slots");
  const nested = childEnvFor({ TMPDIR: os.tmpdir(), PI_ENSEMBLE_HOST_SPAWN_DIR: slots }, "explore");
  // The child's own TMPDIR is its private per-spawn dir: the nested dispatch's
  // `os.tmpdir()` follows it, so anything that resolves lazily against
  // `os.tmpdir()` here would land in the CHILD's tree and stop being shared.
  const childPrivate = path.join(scratch, "child-private");
  await withEnv({ ...nested, TMPDIR: childPrivate }, async () => {
    assert(
      hostSpawnDir() === slots,
      `a nested dispatch inside a child resolves the host slot dir to its parent's path (got ${hostSpawnDir()})`,
    );
    assert(
      hostSpawnDir() !== path.join(childPrivate, path.basename(slots)),
      "the slot dir did not follow the child's TMPDIR into its private tree",
    );
  });
  // And with no absolute override at all, the slot dir is still the shared one:
  // the row is what breaks if `hostSpawnDir()` ever stopped honouring the env.
  await withEnv({ PI_ENSEMBLE_HOST_SPAWN_DIR: undefined }, async () => {
    assert(
      hostSpawnDir() ===
        path.join(os.tmpdir(), `pi-rukas-spawn-slots-${process.getuid?.() ?? "user"}`),
      "with no absolute override the slot dir resolves against the shared root, not a private one",
    );
  });
  // A nested dispatch still gets its OWN per-spawn dir, never its parent's.
  const bare = childEnvFor({ TMPDIR: os.tmpdir(), [CHILD_TMP_ENV]: scratch }, "explore");
  assert(
    bare[CHILD_TMP_ENV] === undefined,
    "an inherited per-child temp root is still stripped from a nested dispatch",
  );
}

// ── 5: the placement canary (the shape the GIT_* canary in test-subagent-git-guard uses) ──
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const src = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  // #2160 moved the child-env assembly into spawn-child-env.ts (spawn.ts sits at
  // the §12 size cap), so the placement pair is read across the two files: the
  // builder applies the temp env last, and the spawn site's one builder call is
  // the only write to the env before `spawn()`.
  const builder = readFileSync(path.join(SRC, "spawn-child-env.ts"), "utf8");
  const callIdx = builder.indexOf("childTempEnv(childTmp)");
  const assignIdx = builder.lastIndexOf("applyChildPermissionEnv(childEnv, plan)");
  const spawnIdx = src.indexOf("env: childEnv,");
  assert(
    callIdx > 0 && assignIdx > 0 && spawnIdx > 0,
    "canary: the child-env builder applies the temp env and spawn.ts reaches spawn() with `env: childEnv`",
  );
  assert(
    callIdx > assignIdx &&
      builder.indexOf("return childEnv", callIdx) > callIdx &&
      builder.lastIndexOf("childEnv", callIdx) < builder.indexOf("return childEnv", callIdx),
    "canary: the TMPDIR/TMP/TEMP assignments are the LAST writes to childEnv in the builder, so no inherited value wins",
  );
  assert(
    /const childEnv = buildChildEnv\(spec\.role, permissions, opts\.writeFence, tmpDir\);/.test(src),
    "canary: spawn.ts builds the child env with the one builder, passing the per-spawn dir",
  );
  const buildIdx = src.indexOf("const childEnv = buildChildEnv(spec.role");
  assert(
    buildIdx > 0 &&
      src.indexOf("childEnv", buildIdx) === src.lastIndexOf("childEnv", spawnIdx),
    "canary: spawn.ts writes nothing to childEnv between the builder call and spawn(), so the temp env cannot be undone",
  );
  const contract = readFileSync(path.join(SRC, "write-fence-contract.ts"), "utf8");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    assert(
      new RegExp(`${name}:\\s*childTmp`).test(contract),
      `canary: childTempEnv sets ${name} to the per-spawn dir`,
    );
  }
  // The explicit `chmod`, not `mkdtemp`'s umask-inherited mode (T2): the #2051
  // harness skip reads owner AND mode, and this dir is now the child's TMPDIR.
  const support = readFileSync(path.join(SRC, "spawn-support.ts"), "utf8");
  assert(
    /chmod\(tmpDir,\s*0o700\)/.test(support),
    "canary: the per-spawn dir's 0700 is set explicitly, not left to the umask",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
