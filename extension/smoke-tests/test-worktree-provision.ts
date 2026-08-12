#!/usr/bin/env bun
/**
 * A worktree with no dependencies cannot run the project's own commands.
 *
 * `git worktree add --detach` materialises tracked files and nothing else, and
 * the develop step then runs the project's verify command inside that tree.
 *
 * How badly that bites is language-dependent, which is why it survived:
 *
 *   - Rust (lantern): `cargo check --quiet` resolves and works — cargo rebuilds
 *     from scratch. Costs minutes per worktree per cycle, not correctness.
 *     Confirmed on lantern 677, which reached handoff with an empty
 *     `verifyEvidence`; that field is written only on failure.
 *   - Node/bun (this repo): resolves to a `bun`/`npm` command that needs
 *     `extension/node_modules`, which is gitignored — the gate fails outright.
 *     pi-ensemble dogfooding `/work` on itself could not pass its own develop
 *     gate in a worktree.
 *
 * Measured, and contradicting an earlier claim of mine that this was
 * unobserved: 20 cycles ran the mechanized branch path and 0 fell back, and
 * every 2026-08-12 cycle used a real `.worktrees/` path. The state files that
 * showed `worktrees = {default: repoRoot}` were pi-ensemble's own, all
 * pre-#287.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NEVER_SHARED,
  SHAREABLE_DEPS,
  looksLikeMissingDeps,
  provisionWorktree,
} from "../src/worktree-provision.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A git that reports the given paths as ignored, and records hook runs. */
const fakeGit = (ignored: string[], runs: string[] = []) => {
  const execFn = async (cmd: string, opts: { cwd?: string }) => {
    if (cmd.startsWith("git check-ignore")) {
      const m = cmd.match(/"([^"]+)"/);
      const rel = m?.[1] ?? "";
      if (ignored.includes(rel)) return { stdout: "" };
      // `git check-ignore -q` exits 1 for a tracked path.
      throw new Error("exit 1");
    }
    if (cmd.startsWith("sh ")) {
      runs.push(`${cmd} @ ${opts.cwd}`);
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  return { execFn, runs };
};

const scratch = () => mkdtempSync(path.join(tmpdir(), "wt-provision-"));

// ------------------------------------------------- the symlink default

{
  const root = scratch();
  const wt = path.join(root, ".worktrees", "issue-1-default");
  try {
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(path.join(root, "target"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");

    const { execFn } = fakeGit(["node_modules", "target"]);
    const result = await provisionWorktree(execFn, root, wt);

    assert(result.via === "symlink", `provisioned by symlink (got ${result.via})`);
    assert(
      result.linked.includes("node_modules"),
      "canary: a gitignored node_modules is linked into the worktree — absent before, and the develop gate failed on it",
    );
    assert(
      await fs
        .readFile(path.join(wt, "node_modules", "marker"), "utf8")
        .then((s) => s === "x")
        .catch(() => false),
      "...and the link actually resolves to repoRoot's copy",
    );
    assert(
      !result.linked.includes("target"),
      "canary: target/ is NOT linked — write-heavy, and sharing it would serialise the fan-out",
    );
    assert(result.problem === undefined, "a clean provision reports no problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------- a TRACKED directory is never shadowed

{
  const root = scratch();
  const wt = path.join(root, ".worktrees", "w");
  try {
    mkdirSync(path.join(root, "vendor"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    // `vendor` exists but is NOT ignored → it is tracked, so `git worktree add`
    // already materialised it and linking would replace real content.
    const { execFn } = fakeGit([]);
    const result = await provisionWorktree(execFn, root, wt);
    assert(
      !result.linked.includes("vendor"),
      "canary: a TRACKED directory is never replaced by a link to elsewhere",
    );
    assert(result.via === "none", "...and nothing was provisioned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- the hook wins

{
  const root = scratch();
  const wt = path.join(root, ".worktrees", "w");
  try {
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "#!/bin/sh\nbun install\n");

    const { execFn, runs } = fakeGit(["node_modules"]);
    const result = await provisionWorktree(execFn, root, wt);

    assert(result.via === "hook", "the project's own hook is preferred over guessing");
    assert(runs.length === 1 && runs[0]?.includes(wt), "...and runs IN the new worktree");
    assert(
      result.linked.length === 0,
      "canary: the symlink default is skipped when a hook exists — the project said what it needs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------- provisioning never fails the step

{
  const root = scratch();
  const wt = path.join(root, ".worktrees", "w");
  try {
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "exit 1\n");
    const execFn = async (cmd: string) => {
      if (cmd.startsWith("sh ")) throw new Error("hook exited 1");
      return { stdout: "" };
    };
    const result = await provisionWorktree(execFn, root, wt);
    assert(
      typeof result.problem === "string" && result.problem.includes("failed"),
      "canary: a failing hook is REPORTED, not thrown — a worktree without deps is the status quo, not a regression",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = scratch();
  const wt = path.join(root, ".worktrees", "w");
  try {
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    // A pre-existing entry makes symlink() throw EEXIST.
    symlinkSync(root, path.join(wt, "node_modules"), "dir");
    const { execFn } = fakeGit(["node_modules"]);
    const result = await provisionWorktree(execFn, root, wt);
    assert(
      result.problem?.includes("node_modules") === true,
      "a link that cannot be created is reported by name",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------------------- the allowlists are sane

{
  const overlap = SHAREABLE_DEPS.filter((d) => (NEVER_SHARED as readonly string[]).includes(d));
  assert(overlap.length === 0, "no directory is both shareable and never-shared");
  assert(
    (NEVER_SHARED as readonly string[]).includes("target"),
    "canary: target/ is on the never-shared list, so a future edit cannot quietly add it",
  );
}

// ------------------------------------------- a missing-deps failure is legible

{
  for (const output of [
    "error: Cannot find module 'typebox'",
    "ModuleNotFoundError: No module named 'requests'",
    "sh: command not found: tsc",
    "error: Cannot find package '@sinclair/typebox'",
  ]) {
    assert(
      looksLikeMissingDeps(output),
      `recognised as a dependency problem: ${output.slice(0, 40)}`,
    );
  }
  for (const output of [
    "test-adversarial-verdict.ts: 3 assertions failed",
    "error[E0308]: mismatched types",
    "TS2345: Argument of type 'string' is not assignable",
  ]) {
    assert(
      !looksLikeMissingDeps(output),
      `canary: a REAL defect is not excused as a dependency problem: ${output.slice(0, 40)}`,
    );
  }
}

// ------------------ this repo's own develop gate runs the real §1 gate

{
  // Without `.pi/verify-cmd` the resolver falls through to `npm run test`,
  // which on this repo is three smoke tests out of ~120, no typecheck and no
  // lint. The gate meant to prove a developer's diff builds proved almost
  // nothing — and it is the gate that would have caught the missing-deps
  // failure this module fixes, so the two belong together.
  const { verifyCmdFor } = await import("../src/work-driver-verify-cmd.ts");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const cmd = (await verifyCmdFor(repoRoot)) ?? "";

  assert(
    cmd !== "npm run test",
    "canary: this repo resolves to its own .pi/verify-cmd, not the three-test `npm run test` fallback",
  );
  assert(/tsc --noEmit/.test(cmd), "...and the gate typechecks");
  assert(/bun run check/.test(cmd), "...and lints");
  assert(
    /smoke-tests\/test-\*/.test(cmd),
    "...and runs the offline smoke suite, not a hand-picked subset",
  );
  assert(/-live\.ts/.test(cmd), "...while excluding the live tests, as AGENTS.md §1 specifies");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
