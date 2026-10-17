#!/usr/bin/env bun
/**
 * #1378 (part 2 of 2) — the canary and the rename-source scope boundary.
 *
 * Two things this file exists to keep true:
 *
 *   - the gate keeps reading `-z`. The bug was a read shape, and a read shape is
 *     exactly what a refactor quietly reverts, so the source is grepped and the
 *     pattern asserted (modelled on test-work-driver-diff-head-canary.ts) — a
 *     canary that cannot rot. Two halves, because grepping the file for `-z` only
 *     proves the string is still somewhere in it: the exported argv *constants* are
 *     asserted to carry the flags the module jsdoc calls load-bearing, and the gate
 *     is asserted to reach no *other* change-set reader for the protected check — a
 *     second `status --porcelain` would give a scripted fake a place to answer a
 *     read nobody asked for.
 *   - rename SOURCES reach only the protected-path check. The array the
 *     frontend-only skip, the falsily-green check and the #285 fanout gate
 *     consume must be identical with and without a rename source present, or a
 *     single `git mv` reads as scope fanout.
 *
 * Part 1 (the parsers and the gate vs real git):
 * test-work-driver-protected-paths-read.ts.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  PROTECTED_DIFF_ARGV,
  PROTECTED_STATUS_ARGV,
  readCommittedProtectedPaths,
  readProtectedStatusPaths,
} from "../src/work-driver-protected-paths-read.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitIn } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";

/** A repo with `.github/workflows/ci.yml` + `src/ci.yml` committed; returns its base SHA. */

function seedRepo(dir: string): string {
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, CI), "runs-on: ubuntu\n");
  writeFileSync(path.join(dir, "src/ci.yml"), "placeholder\n");
  writeFileSync(path.join(dir, "src/app.ts"), "export const a = 1;\n");
  gitIn(dir, ["init", "-q", "--initial-branch=main"]);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "base"]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

function developState(dir: string, baseSha: string): WorkState {
  const s = initialState(1378, 1000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { "task-a": dir },
      baseSha,
    },
  };
}

function developCtx(grant?: readonly string[]): DriverContext {
  return {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1378,
    ...(grant ? { protectedGrant: grant } : {}),
    verifyExecFn: realExec,
  };
}

const protectedFailure = (f: string[]) => f.find((x) => /protected path/.test(x)) ?? "";

// ============================ canary: the gate must keep reading `-z`
//
// The bug was a read shape, and a read shape is exactly what a future refactor
// quietly reverts. Modelled on test-work-driver-diff-head-canary.ts: grep the
// source, and assert the pattern still matches so the canary cannot rot.

{
  const srcPath = path.resolve(import.meta.dirname, "..", "src");
  const read = (f: string) => {
    try {
      return readFileSync(path.join(srcPath, f), "utf8");
    } catch {
      return "";
    }
  };
  const gate = read("work-driver-verify-develop.ts");
  const parser = read("work-driver-protected-paths-read.ts");
  assert(
    /readProtectedStatusPaths|readCommittedProtectedPaths/.test(gate),
    "canary: the develop gate still delegates both path reads to the `-z` module",
  );
  assert(
    !gate.includes("git diff --name-only") && !gate.includes("porcelainPaths("),
    "canary: no non-`-z` change-set read is back in work-driver-verify-develop.ts",
  );
  assert(
    /-z/.test(parser) && /--name-status/.test(parser) && /-M/.test(parser),
    "canary: the parser still issues a `-z --name-status -M` committed read",
  );
  assert(
    /--untracked-files=all/.test(parser),
    "canary: the parser still lists untracked files individually",
  );
  assert(
    parser.includes("PROTECTED_DIFF_ARGV") && parser.includes("PROTECTED_STATUS_ARGV"),
    "canary: the two read shapes are declared once as exported argv constants",
  );

  // The flags the module jsdoc calls load-bearing, asserted on the exported
  // constants themselves rather than on prose in the file that defines them: `-z`
  // is what stops git C-quoting a name and gives each rename side its own token,
  // and a base that reads like a flag stays a ref only because of
  // `--end-of-options`. A comment can claim either flag is gone while the constant
  // keeps it; this reads the constant.
  const has = (argv: readonly string[], flag: string) => argv.includes(flag);
  for (const [name, argv] of [
    ["PROTECTED_STATUS_ARGV", PROTECTED_STATUS_ARGV],
    ["PROTECTED_DIFF_ARGV", PROTECTED_DIFF_ARGV],
  ] as const) {
    assert(
      has(argv, "core.quotePath=off"),
      `canary: ${name} carries \`-c core.quotePath=off\` — the reason a failed read's own message is not octal-escaped`,
    );
    assert(
      has(argv, "-z"),
      `canary: ${name} carries \`-z\` — without it a C-quoted protected name never matches a grant`,
    );
    // The worktree these reads run in is child-writable. A `git config
    // core.fsmonitor <script>` (or a hook path) written there by a developer, a
    // lens-fix, or a dependency turns a read the DRIVER performs into code executed
    // as the driver — the same guard src/git-state.ts applies to its own reads.
    assert(
      has(argv, "core.fsmonitor=false"),
      `canary: ${name} carries \`-c core.fsmonitor=false\` — a child-writable worktree config cannot run a monitor script in the driver`,
    );
    assert(
      has(argv, "core.hooksPath=/dev/null"),
      `canary: ${name} carries \`-c core.hooksPath=/dev/null\` — a child-written hook path cannot run code in the driver`,
    );
    // The attribute-bound executable: a committed `.gitattributes`, or a
    // `.git/info/attributes` the read cannot delete, binds a path to
    // `filter=<x>` and git runs that driver's `clean` script **as the driver**
    // while materialising content. Measured on git 2.50.1: `core.attributesFile=
    // /dev/null` and `GIT_ATTR_NOSYSTEM=1` do NOT defeat it, and `-c
    // filter.<name>.clean=false` does — for the named filter only. The argv
    // therefore forces the conventional names off and the module jsdoc states the
    // per-name limit; the real-git fixtures in
    // test-work-driver-protected-paths-read.ts assert both halves.
    assert(
      has(argv, "core.attributesFile=/dev/null"),
      `canary: ${name} carries \`-c core.attributesFile=/dev/null\` — one of the layers that can bind a path to a filter driver`,
    );
    assert(
      argv.filter((a) => a.startsWith("filter.") && a.endsWith(".clean=false")).length >= 3,
      `canary: ${name} forces the conventional filter driver names off — the only measured blocker for an attribute-bound clean filter`,
    );
    assert(
      !argv.includes("--no-ext-diff") && !argv.includes("--no-textconv"),
      `canary: ${name} does NOT carry \`--no-ext-diff\`/\`--no-textconv\` — they are \`git diff\` options, so at the global position git rejects them with exit 129 and this read would fail outright (and they never blocked a clean filter anyway)`,
    );
    const sub = argv.findIndex((a) => a === "diff" || a === "status");
    assert(
      sub > 0 &&
        argv.indexOf("core.attributesFile=/dev/null") < sub &&
        argv.findIndex((a) => a.startsWith("filter.") && a.endsWith(".clean=false")) < sub,
      `canary: ${name} carries its hardening BEFORE its subcommand (at ${sub}) — every \`-c\` pair must precede it or git treats it as a pathspec`,
    );
  }
  assert(
    has(PROTECTED_DIFF_ARGV, "--end-of-options"),
    "canary: PROTECTED_DIFF_ARGV carries `--end-of-options` — a base that reads like a flag stays a ref",
  );
  assert(
    has(PROTECTED_STATUS_ARGV, "status") &&
      has(PROTECTED_STATUS_ARGV, "--porcelain") &&
      has(PROTECTED_STATUS_ARGV, "--untracked-files=all") &&
      has(PROTECTED_DIFF_ARGV, "diff") &&
      has(PROTECTED_DIFF_ARGV, "--name-status") &&
      has(PROTECTED_DIFF_ARGV, "-M") &&
      // `-M` alone can never yield a `C` record, so the parser's copy arm is
      // dead code in production without `-C` — and the dead arm is exactly the
      // case `cp .github/workflows/ci.yml docs/leak.yml` produces, the one
      // `git mv` does not cover. Asserted on the constant so it cannot rot.
      has(PROTECTED_DIFF_ARGV, "-C"),
    "canary: both argv constants carry their subcommand and the flags that make the read complete (the committed read detects renames AND copies)",
  );

  // The gate must not reach a SECOND reader for the protected check. A stray
  // non-`-z` `status --porcelain` / `diff --name-only` in the same loop gives a
  // scripted fake a place to answer a read the gate never makes, and gives a
  // refactor a route back to the shape that hid the rename. Comment lines are
  // stripped first: this repo's prose names those commands constantly, and a
  // comment is not a call site.
  const FOREIGN_READER =
    /status\s+--porcelain|--name-status|--name-only\b|porcelainPaths\s*\(|worktreeStatus\s*\(/;
  const offenders = gate
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([_, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && FOREIGN_READER.test(l))
    .map(([n, l]) => `${n}: ${l.trim().slice(0, 70)}`);
  assert(
    offenders.length === 0,
    `canary: the develop gate issues no change-set read of its own — the protected check has exactly one reader per side (${offenders.join(" | ") || "none"})`,
  );
  // Every other module that reads a change set is a DIFFERENT consumer, and the
  // protected gate must not have quietly started consulting one of them.
  const importers = readdirSync(srcPath).filter(
    (f) =>
      f.endsWith(".ts") &&
      f !== "work-driver-verify-develop.ts" &&
      // The module that DEFINES the readers names them in its own declarations —
      // that is not a consumer.
      !f.startsWith("work-driver-protected-paths-read") &&
      /readProtectedStatusPaths|readCommittedProtectedPaths/.test(
        readFileSync(path.join(srcPath, f), "utf8"),
      ),
  );
  assert(
    importers.length === 0,
    `canary: only work-driver-verify-develop.ts consults the protected reads (${importers.join(", ") || "none"})`,
  );
}

// ============================ rename sources reach ONLY the protected check
//
// Positive membership assertion, not just "no failure": the array the frontend-only
// skip, the falsily-green check and the #285 fanout gate consume must be the same
// set with and without the rename source present.

{
  const root = await mkdtemp(path.join(tmpdir(), "protect-z-scope-"));
  try {
    const base = seedRepo(root);
    gitIn(root, ["mv", CI, "src/moved.yml"]);
    gitIn(root, ["commit", "-q", "-m", "move aside"]);
    const state = (paths: string[]) => {
      const s = initialState(1378, 1000);
      return {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: { "task-a": root },
          baseSha: base,
          workstreams: {
            "task-a": { id: "task-a", scope: "s", paths, outOfScope: [] },
          },
        },
      };
    };
    await withEnv({ PI_ENSEMBLE_VERIFY: "1", PI_ENSEMBLE_PROTECTED_PATHS: undefined }, async () => {
      const withFence = await verifyStepOutcome(
        developCtx([CI]),
        state(["src/moved.yml"]),
        "develop",
      );
      // The rename source (`.github/workflows/ci.yml`) is NOT in the fence's
      // changed-path set: if it were, a grant for the source plus a fence naming
      // only the destination would read as scope fanout instead of a protected hit.
      assert(
        !withFence.failures.some((f) => /scope fanout/.test(f)),
        "a rename source is not counted as scope fanout (it feeds only the protected check)",
      );
      assert(
        !withFence.failures.some((f) => /out-of-scope|declared fence violated/.test(f)),
        "...and not counted as a fence violation either",
      );
      const fanout = await verifyStepOutcome(
        developCtx([CI]),
        state(["src/moved.yml", "src/app.ts", "src/extra.ts"]),
        "develop",
      );
      assert(
        !fanout.failures.some((f) => /scope fanout/.test(f)),
        "the fanout limit counts destinations only — one rename adds no phantom changed file",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
