#!/usr/bin/env bun
/**
 * lean/spec-intake-switch — the `require` / `derive` switch, R1.
 *
 * The switch is what lets a hand-written ticket (no `pi-spec v1` block) run at
 * all, so its resolution order is the whole contract:
 *
 *   env > `.pi/work.json` `lean.specIntake` > `require`
 *
 * and each arm needs its own case, because the failure mode of a merged
 * resolution function is "one arm quietly wins".
 *
 * Two rules the brief states and this file pins rather than trusts:
 *
 *   - an env value that is neither `require` nor `derive` is an ERROR naming the
 *     allowed values, never a fallback to the default — a typo'd knob that read
 *     as "the safe setting" is a silent behaviour change;
 *   - the env is read at CALL time, so a case in this process cannot pin the
 *     next case's arm (the same convention every other lean switch follows).
 *
 * The work.json half is judged through the real loader (`loadWorkConfig`) on a
 * real temp repo, so an invalid `lean.specIntake` fails the way a typo'd budget
 * does — `LeanConfigError`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { LeanConfigError, loadWorkConfig } from "../src/lean/config.ts";
import {
  SPEC_INTAKE_VALUES,
  SpecIntakeError,
  resolveSpecIntake,
  validateSpecIntake,
} from "../src/lean/spec-intake-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { worktreeCommit } from "./lib/lean-spec-intake-fixtures.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    failed = 1;
  }
}

/** A temp repo with git identity configured; the caller commits and removes it. */
function tempGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-intake-switch-"));
  const run = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...gitTestEnv(),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  return dir;
}

// ── The value set and the validator, on their own.
assert(
  JSON.stringify(SPEC_INTAKE_VALUES) === JSON.stringify(["require", "derive"]),
  `the accepted values are exactly require and derive (got ${JSON.stringify(SPEC_INTAKE_VALUES)})`,
);
assert(validateSpecIntake("require") === "require", "require validates");
assert(validateSpecIntake("derive") === "derive", "derive validates");
assert(
  validateSpecIntake(undefined) === undefined,
  "an absent value validates to undefined (so the next source decides)",
);
for (const bad of ["", "DERIVE", "yes", "0", "1", "derive ", "true"]) {
  let threw: unknown;
  try {
    validateSpecIntake(bad);
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof SpecIntakeError,
    `validateSpecIntake(${JSON.stringify(bad)}) is a SpecIntakeError, not a fallback`,
  );
  const message = threw instanceof Error ? threw.message : "";
  assert(
    SPEC_INTAKE_VALUES.every((v) => message.includes(v)),
    `…and its message names both allowed values for ${JSON.stringify(bad)} (got ${JSON.stringify(message)})`,
  );
}

// ── (env > config) the env wins when set; a refused env value never falls back.
{
  const repo = tempGitRepo();
  try {
    const sha = worktreeCommit(repo, {
      ".pi/work.json": JSON.stringify({ version: 1, lean: { specIntake: "require" } }),
    });
    const loaded = await loadWorkConfig(execp, repo, sha);
    assert(
      loaded.lean?.specIntake === "require",
      `the committed config reads back as require (got ${JSON.stringify(loaded.lean?.specIntake)})`,
    );
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: "derive" }, async () => {
      assert(
        resolveSpecIntake(loaded) === "derive",
        `env derive outranks work.json require (got ${resolveSpecIntake(loaded)})`,
      );
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      assert(
        resolveSpecIntake(loaded) === "require",
        `with no env, work.json decides (got ${resolveSpecIntake(loaded)})`,
      );
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: "deriver" }, async () => {
      let threw: unknown;
      try {
        resolveSpecIntake(loaded);
      } catch (err) {
        threw = err;
      }
      assert(
        threw instanceof SpecIntakeError,
        `an unknown env value throws rather than falling back (got ${String(threw)})`,
      );
      const message = threw instanceof Error ? threw.message : "";
      assert(
        SPEC_INTAKE_VALUES.every((v) => message.includes(v)) &&
          message.includes("deriver") &&
          message.includes("PI_ENSEMBLE_LEAN_SPEC_INTAKE"),
        `…and names the knob, both allowed values and the refused one (got ${JSON.stringify(message)})`,
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── (config > default) the shipped default is require, and the key round-trips.
for (const [body, want, label, resolves] of [
  ['{"version":1}', undefined, "no lean object at all", "require"],
  ['{"version":1,"lean":{}}', undefined, "an empty lean object", "require"],
  ['{"version":1,"lean":{"specIntake":"require"}}', "require", "an explicit require", "require"],
  ['{"version":1,"lean":{"specIntake":"derive"}}', "derive", "an explicit derive", "derive"],
] as const) {
  const repo = tempGitRepo();
  try {
    const sha = worktreeCommit(repo, { ".pi/work.json": body });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      const loaded = await loadWorkConfig(execp, repo, sha);
      assert(
        loaded.lean?.specIntake === want,
        `${label}: lean.specIntake reads back as ${String(want)} (got ${JSON.stringify(loaded.lean?.specIntake)})`,
      );
      assert(
        resolveSpecIntake(loaded) === resolves,
        `${label}: with no env the run resolves to ${resolves} (got ${resolveSpecIntake(loaded)})`,
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── A derive config with no env really resolves to derive (the other half of the
// precedence — the loop above can only ask the default arm).
{
  const repo = tempGitRepo();
  try {
    const sha = worktreeCommit(repo, {
      ".pi/work.json": JSON.stringify({ version: 1, lean: { specIntake: "derive" } }),
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      const loaded = await loadWorkConfig(execp, repo, sha);
      assert(
        resolveSpecIntake(loaded) === "derive",
        `work.json derive with no env resolves to derive (got ${resolveSpecIntake(loaded)})`,
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── An invalid config value is refused at LOAD, like every other key.
for (const [body, needle] of [
  ['{"version":1,"lean":{"specIntake":1}}', "lean.specIntake"],
  ['{"version":1,"lean":{"specIntake":"DERIVE"}}', "lean.specIntake"],
  ['{"version":1,"lean":{"specIntake":null}}', "lean.specIntake"],
  ['{"version":1,"lean":[]}', "lean must be an object"],
  ['{"version":1,"lean":null}', "lean must be an object"],
] as const) {
  const repo = tempGitRepo();
  try {
    const sha = worktreeCommit(repo, { ".pi/work.json": body });
    let threw: unknown;
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      try {
        await loadWorkConfig(execp, repo, sha);
      } catch (err) {
        threw = err;
      }
    });
    assert(
      threw instanceof LeanConfigError,
      `${body} is refused at load with LeanConfigError (got ${String(threw)})`,
    );
    const message = threw instanceof Error ? threw.message : "";
    assert(
      message.includes(needle),
      `…and its reason names ${JSON.stringify(needle)} (got ${JSON.stringify(message)})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── The env is read at CALL time, not at module load.
{
  const repo = tempGitRepo();
  try {
    const sha = worktreeCommit(repo, { ".pi/work.json": '{"version":1}' });
    const loaded = await loadWorkConfig(execp, repo, sha);
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      assert(resolveSpecIntake(loaded) === "require", "unset env means require");
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: "derive" }, async () => {
      assert(resolveSpecIntake(loaded) === "derive", "setting it after load still takes effect");
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      assert(resolveSpecIntake(loaded) === "require", "and un-setting it again reverts");
    });
    // With no config in hand at all (a run that has not loaded one yet), the
    // answer is still require — the default arm must not need a config.
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      assert(resolveSpecIntake(undefined) === "require", "no config at all still means require");
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.exit(failed);
