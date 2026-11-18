/**
 * test-reviewer-scratch-home-2352 — the scratch HOME a read-only child's bash
 * runs with, and the re-exports that keep it from costing the child the tools a
 * review needs (#2352 R12).
 *
 * The incident the redirect answers: a reviewer child probed a target project by
 * writing through `$HOME` / `$XDG_STATE_HOME`, and every byte landed in the
 * operator's real home, because a child inherits it. The five variables below are
 * what a child's bash sees instead; the three re-exports are what it must NOT lose
 * (R12) — and the vipune one is the test that matters, because vipune resolves its
 * default store from the passwd entry rather than from `$HOME`, so a redirected
 * `HOME` alone would have left the operator's memory store reachable (R10).
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REEXPORTED_HOME_ROOTS,
  SCRATCH_HOME_DIR,
  SCRATCH_HOME_SWITCH,
  SCRATCH_HOME_VARS,
  WRITE_GUARD_SWITCH,
  isConfinedRole,
  reviewerScratchHome,
  reviewerScratchHomeEnabled,
  reviewerScratchHomeEnv,
  reviewerWriteGuardEnabled,
} from "../src/reviewer-scratch-home.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "scratch-home-2352-"));
const childTmp = path.join(root, "ct");
mkdtempSync(childTmp);

function run() {
  console.log("── switches ──");
  assert.equal(SCRATCH_HOME_SWITCH, "PI_ENSEMBLE_REVIEWER_SCRATCH_HOME");
  assert.equal(WRITE_GUARD_SWITCH, "PI_ENSEMBLE_REVIEWER_WRITE_GUARD");
  assert.equal(reviewerScratchHomeEnabled({}), true, "default ON");
  assert.equal(reviewerScratchHomeEnabled({ [SCRATCH_HOME_SWITCH]: "0" }), false);
  assert.equal(reviewerScratchHomeEnabled({ [SCRATCH_HOME_SWITCH]: "" }), true, '"0" only');
  assert.equal(reviewerWriteGuardEnabled({ [WRITE_GUARD_SWITCH]: "0" }), false);
  // The pair is independent: each switches its own half and neither implies the other.
  assert.equal(
    reviewerScratchHomeEnabled({ [WRITE_GUARD_SWITCH]: "0" }),
    true,
    "the guard's switch does not turn the redirect off",
  );

  console.log("── the env a confined child gets ──");
  const home = path.join(childTmp, SCRATCH_HOME_DIR);
  assert.equal(reviewerScratchHome(childTmp), home, "the scratch is a home/ under the child's dir");
  const parent = {
    PI_CODING_AGENT_DIR: "/parent/.pi/agent",
    PI_AGENT_DIR: "/parent/.pi/agent",
    PI_ENSEMBLE_SKILLS_DIR: "/parent/skills",
    VIPUNE_DATABASE_PATH: "/parent/vipune.db",
  };
  const env = reviewerScratchHomeEnv(
    "adversarial-developer",
    childTmp,
    parent,
    () => "/parent-home",
  );
  assert.deepEqual(SCRATCH_HOME_VARS, [
    "HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ] as const);
  for (const v of SCRATCH_HOME_VARS) {
    const value = env[v];
    assert.ok(value !== undefined, `${v} is set`);
    assert.ok(value.startsWith(home), `${v} is under the scratch home (${value})`);
    assert.ok(path.isAbsolute(value), `${v} is absolute`);
  }
  assert.equal(env.HOME, home);
  assert.equal(env.XDG_STATE_HOME, path.join(home, ".local", "state"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(home, ".config"));
  assert.equal(env.XDG_DATA_HOME, path.join(home, ".local", "share"));
  assert.equal(env.XDG_CACHE_HOME, path.join(home, ".cache"));

  // R12: the home-derived roots survive the redirect at the parent's own values.
  // `PI_CODING_AGENT_DIR` is the name PI reads for its config dir and is the
  // #2368 half of this list; `PI_AGENT_DIR` is pi-rukas's own name for the same
  // tree — both travel, see the module's jsdoc.
  assert.deepEqual(
    [...REEXPORTED_HOME_ROOTS],
    [
      "PI_CODING_AGENT_DIR",
      "PI_AGENT_DIR",
      "PI_ENSEMBLE_SKILLS_DIR",
      "VIPUNE_DATABASE_PATH",
    ],
  );
  assert.equal(env.PI_CODING_AGENT_DIR, "/parent/.pi/agent");
  assert.equal(env.PI_AGENT_DIR, "/parent/.pi/agent");
  assert.equal(env.PI_ENSEMBLE_SKILLS_DIR, "/parent/skills");
  assert.equal(env.VIPUNE_DATABASE_PATH, "/parent/vipune.db");

  // R10: vipune's REAL variable. `VIPUNE_DB_PATH` is what pi-rukas's own stats
  // reader reads and vipune ignores, so pinning that one would have been a no-op
  // and the operator's store would still have been the one the child opened.
  assert.ok(!("VIPUNE_DB_PATH" in env), "the wrong name is not set — the right one is the point");
  assert.equal(
    reviewerScratchHomeEnv("explore", childTmp, {}, () => "/parent-home").VIPUNE_DATABASE_PATH,
    path.join("/parent-home", ".vipune", "memories.db"),
    "with no parent value it falls back to the passwd-style home the owning module uses",
  );
  assert.equal(
    reviewerScratchHomeEnv("explore", childTmp, {}, () => "/parent-home").PI_AGENT_DIR,
    path.join("/parent-home", ".pi", "agent"),
  );
  // #2368: the name PI itself reads, and the same parent-home default. Left
  // unset, a confined child would resolve its config dir under the scratch HOME
  // and die in model resolution with `Unknown provider`.
  assert.equal(
    reviewerScratchHomeEnv("explore", childTmp, {}, () => "/parent-home").PI_CODING_AGENT_DIR,
    path.join("/parent-home", ".pi", "agent"),
    "PI_CODING_AGENT_DIR falls back to the parent's home, never the scratch's",
  );
  assert.notEqual(
    reviewerScratchHomeEnv("explore", childTmp, {}, () => "/parent-home").PI_CODING_AGENT_DIR,
    path.join(path.join(childTmp, SCRATCH_HOME_DIR), ".pi", "agent"),
    "the child's config dir is never inside the scratch HOME",
  );
  assert.equal(
    reviewerScratchHomeEnv("explore", childTmp, { PI_CODING_AGENT_DIR: "" }, () => "/parent-home")
      .PI_CODING_AGENT_DIR,
    path.join("/parent-home", ".pi", "agent"),
    "an empty value is unset here too, as it is in pi's own getAgentDir",
  );

  console.log("── who gets it ──");
  for (const role of ["adversarial-developer", "code-review-specialist", "explore"]) {
    assert.ok(isConfinedRole(role), `${role} is confined (R5: the whole read-only set)`);
    assert.equal(reviewerScratchHomeEnv(role, childTmp, parent).HOME, home);
  }
  for (const role of ["developer", "ops", "lens-fix", "project-manager", ""]) {
    assert.deepEqual(
      reviewerScratchHomeEnv(role, childTmp, parent),
      {},
      `${role || "(empty)"} gets no redirect — the driver's fence confines it`,
    );
  }

  console.log("── the scratch exists before the child runs ──");
  // A tool that finds no HOME writes nothing and reports success, which is
  // indistinguishable from the isolation having worked — so the HOME dirs must exist.
  // Only the five home roots are directories; the re-exports name files elsewhere.
  const made = reviewerScratchHomeEnv("explore", childTmp, {});
  for (const v of SCRATCH_HOME_VARS) {
    const dir = made[v];
    assert.ok(dir !== undefined && existsSync(dir), `${dir} exists on disk`);
    assert.ok(statSync(dir).isDirectory(), `${dir} is a directory`);
    assert.ok(dir.startsWith(childTmp), `${dir} is inside the per-spawn dir the spawn removes`);
  }

  console.log("── the parent session is untouched ──");
  assert.equal(process.env.HOME, undefined ? undefined : process.env.HOME);
  const before = { ...process.env };
  reviewerScratchHomeEnv("adversarial-developer", childTmp, {});
  assert.equal(process.env.HOME, before.HOME, "the builder never writes the caller's env");
  assert.equal(process.env.XDG_STATE_HOME, before.XDG_STATE_HOME);
  assert.ok(
    existsSync(os.homedir()),
    "the operator's real home was never the thing under test here",
  );
  rmSync(root, { recursive: true, force: true });
}

run();
console.log("\nreviewer-scratch-home (#2352): all groups passed");
