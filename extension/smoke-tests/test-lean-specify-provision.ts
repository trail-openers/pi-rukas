#!/usr/bin/env bun
/**
 * lean/specify, part 5 — the RESET removes the dependency links and
 * provisioning builds them again.
 *
 * `resetWorktreeToBase` cleans with `-fdx` and NO `-e` exemption list: the
 * provisioned links are removed with everything else untracked, and
 * `ensureSpecifyWorktreeWithProvision` re-creates them. The two halves of that
 * are why this case exists. Exempting the links by name meant a leftover tree
 * kept whatever links its first provisioning made, with nothing checking they
 * still pointed anywhere; and `-e` matching is pattern-based, so a base
 * `.gitignore` of `node_modules/` (the trailing-slash form, the common one) and
 * a NESTED tree like `extension/node_modules` are exactly where an exemption
 * list goes wrong. After the reset the links must exist, be provisioning's
 * symlinks, be excluded from `git status`, and the child's file hidden behind
 * the base's own ignore rule must be gone.
 *
 * Case (t): lean's trees under `.worktrees/` are excluded per clone, so neither the repo root's
 * status nor a `git add -A` there during a base probe picks them up.
 *
 * The fixture is lib/lean-specify-fixture.ts.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { probeTierAtBase, probeWorktreePath } from "../src/lean/verify-baseline.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
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

// -------- (s) a `node_modules/`-ignored repo with a nested link resets cleanly
{
  // The base `.gitignore` uses the trailing-slash form, and provisioning links
  // a NESTED tree (`extension/node_modules`) as well as the root one. `git
  // clean -fdx` now removes both — with no `-e` list to keep them alive — and
  // provisioning re-creates them, so the reset path and the create path build
  // the tree the same way.
  const { repoRoot, baseSha } = makeRepo({
    ".gitignore": "node_modules/\n",
    "package.json": `${JSON.stringify({ name: "lean-fixt", version: "1.0.0" })}\n`,
    "src/a.ts": "1\n",
  });
  // A package directory needs its OWN manifest before provisioning will look
  // inside it for a nested tree — that is what `packageDirsAt` discovers.
  mkdirSync(path.join(repoRoot, "extension"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "extension", "package.json"),
    `${JSON.stringify({ name: "lean-ext", version: "1.0.0" })}\n`,
  );
  mkdirSync(path.join(repoRoot, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(repoRoot, "node_modules", "left-pad", "index.js"), "module.exports=1;\n");
  mkdirSync(path.join(repoRoot, "extension", "node_modules", "right-pad"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "extension", "node_modules", "right-pad", "index.js"),
    "module.exports=2;\n",
  );
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 18,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      // A stray file the child hides behind the base's own ignore rule.
      writeFileSync(path.join(wt, "junk.log"), "hidden\n");
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, `(s) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(s) ok, got ${r.outcome?.kind}`);
  for (const rel of ["node_modules", "extension/node_modules"]) {
    const st = existsSync(path.join(r.worktree, rel))
      ? lstatSync(path.join(r.worktree, rel))
      : undefined;
    assert(st !== undefined && st.isSymbolicLink() === true, `(s) ${rel} exists after the reset and is a provisioning link`);
  }
  assert(
    git(r.worktree, "status", "--porcelain", "-uall") === "",
    `(s) the re-created links are excluded and the tree is clean (got ${git(r.worktree, "status", "--porcelain", "-uall")})`,
  );
  assert(
    !existsSync(path.join(r.worktree, "junk.log")),
    "(s) the file hidden by the base's ignore rule is gone",
  );
}

// -------- (t) lean's trees under `.worktrees/` are invisible to the repo root's status
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  await runSpecify({
    repoRoot,
    baseSha,
    issue: 19,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  const status = git(repoRoot, "status", "--porcelain", "--untracked-files=all");
  assert(
    existsSync(path.join(repoRoot, ".worktrees")) && !status.includes(".worktrees"),
    `(t) the repo root's status does not list .worktrees/ (${JSON.stringify(status).slice(0, 160)})`,
  );
  // A `git add -A` at the repo root while verify's base probe tree is checked out stages none of it.
  const probe = await probeTierAtBase({
    repoRoot,
    baseSha,
    issue: 19,
    cmd: `git -C '${repoRoot}' add -A && test -d '${probeWorktreePath(repoRoot, 19, "baseline")}'`,
    timeoutMs: 30_000,
    exec: ((cmd: string, o?: object) => execp(cmd, o ?? {})) as unknown as VerifyExec,
    frozen: {},
  });
  const staged = git(repoRoot, "diff", "--cached", "--name-only");
  assert(
    probe.status === "green" && !staged.includes(".worktrees"),
    `(t) git add -A during a base probe stages nothing under .worktrees/ (${probe.status}; ${JSON.stringify(staged).slice(0, 160)})`,
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
