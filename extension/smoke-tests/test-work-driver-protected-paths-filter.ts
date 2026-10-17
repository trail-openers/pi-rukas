#!/usr/bin/env bun
/**
 * #1378 (part 1c of 4) — the guarded reads against an attribute-bound filter
 * driver, in a CHILD-WRITABLE worktree. Split out of
 * test-work-driver-protected-paths-read.ts for the 500-line cap; the shared
 * real-git helpers are `gitIn` in lib/git-worktree-fixture.ts and `realExec`
 * in lib/exec-fake.ts (there is no dedicated fixture module for this test).
 *
 * The read is only as safe as what git EXECUTES while producing it. A developer,
 * a lens-fix, or a dependency can drop a script in the worktree, point a
 * `filter.<x>.clean` config at it, and bind it to the protected path with
 * `*.yml filter=x` — from a committed `.gitattributes`, or from
 * `.git/info/attributes`, which is untracked so the read can never remove it.
 * git then runs that script **as the driver** while materialising content.
 *
 * Everything asserted here was MEASURED against git 2.50.1 first, because the
 * obvious answers are wrong:
 *
 *   - `-c core.attributesFile=/dev/null` does NOT defeat the binding. git keeps
 *     an index/worktree attribute stack, `check-attr` still reports the filter,
 *     and the script still runs. `GIT_ATTR_NOSYSTEM=1` only drops the system
 *     file, so it does not either.
 *   - `--no-ext-diff` / `--no-textconv` are worse than useless. They are `git
 *     diff` options, so at the GLOBAL position git rejects them outright
 *     (`unknown option`, exit 129) — adding them to a shared config list breaks
 *     BOTH reads. After the subcommand git accepts them, but they silence an
 *     external-diff command and a textconv driver, neither of which a
 *     `--name-status` read reaches: the clean filter still ran with both present.
 *     The canary asserts they are ABSENT from both argv constants.
 *   - `-c filter.<name>.clean=false` DOES block it — for that name, and git
 *     still emits the record. There is no wildcard: `-c 'filter.*.clean=false'`
 *     sets one literal key, and with three paths bound to three different filter
 *     names all three scripts still ran with it present. So the argv forces the
 *     conventional names off and the module jsdoc states the per-name limit.
 *
 * Every guarded case runs a POSITIVE CONTROL first — the same fixture, an
 * unguarded one-sided `git diff`, which MUST run the script. Without it a
 * guarded assertion could be green because the binding never took, the config
 * name was wrong, or the script was not executable, and each of those is
 * indistinguishable from a working guard.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  PROTECTED_DIFF_ARGV,
  PROTECTED_STATUS_ARGV,
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

// The filter names the guarded argv forces off. A fixture binds one of these to
// assert the guard works, and one NOT in the list to assert its limit.
const GUARDED_NAMES = ["x", "git", "pi-rukas-guarded"] as const;

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
    pipelineState: { ...s.pipelineState, worktrees: { "task-a": dir }, baseSha },
  };
}

function developCtx(): DriverContext {
  return {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1378,
    verifyExecFn: realExec,
  };
}

const protectedFailure = (f: readonly string[]) => f.find((x) => /protected path/.test(x)) ?? "";

/**
 * Run the two exported argv constants verbatim, through the real executor. A
 * test-local reconstruction of the command line would let the guard under test
 * drift out of what the assertion exercises — the vacuous-fake class
 * `lib/nul-porcelain.ts` exists for, applied to the executable side.
 */
async function readBothGuardedReads(dir: string, base: string): Promise<void> {
  // A throw here is a regression in the argv (an option git rejects, a bad option
  // position) and must surface, not be swallowed.
  await realExec("git", { argv: [...PROTECTED_STATUS_ARGV], cwd: dir });
  await realExec("git", { argv: [...PROTECTED_DIFF_ARGV, `${base}..HEAD`], cwd: dir });
}

await withEnv({ PI_ENSEMBLE_VERIFY: "1", PI_ENSEMBLE_PROTECTED_PATHS: undefined }, async () => {
  // The names the guarded argv forces off. `x` is the spelling the fixtures use.

  const bindCase = async (opts: {
    label: string;
    /** How the attribute binding is placed (tracked vs untracked). */
    bind: (dir: string) => void;
    /** The filter name the child binds and configures. */
    filterName: string;
    /** Whether the guarded argv names this filter (so it must be blocked). */
    guarded: boolean;
  }): Promise<void> => {
    const root = mkdtempSync(path.join(tmpdir(), "protect-filter-"));
    try {
      const dir = path.join(root, "wt");
      mkdirSync(dir, { recursive: true });
      const base = seedRepo(dir);
      const script = path.join(dir, "evil-filter.sh");
      const marker = path.join(dir, "FILTER_RAN");
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexec cat\n`);
      chmodSync(script, 0o755);
      opts.bind(dir);
      gitIn(dir, ["config", `filter.${opts.filterName}.clean`, script]);
      // Leave the protected file DIRTY: a clean worktree gives git nothing to
      // materialise and the case would pass without exercising anything.
      writeFileSync(path.join(dir, CI), "runs-on: ubuntu\nchild-wrote-this\n");

      // (a) The counterfactual, run FIRST and always: an UNGUARDED one-sided
      //     `git diff` in this same fixture must run the script. Without it the
      //     guarded assertions below could be green because the binding never
      //     took, the config name was wrong, or the script was not executable —
      //     every one of those is indistinguishable from a working guard.
      gitIn(dir, ["-c", "core.quotePath=off", "diff", "--name-status", "-M", "HEAD"]);
      assert(
        existsSync(marker),
        `${opts.label}: positive control — an UNGUARDED \`git diff … HEAD\` DOES run the child's script (so the binding is live)`,
      );

      // (b) THIS MODULE'S CONTRACT, asserted directly: the two exported argv
      //     constants, run against this fixture, never execute the child's
      //     script. Direct rather than through the gate, because the gate issues
      //     a THIRD read of its own — the skip-ratchet content diff, `git diff
      //     <base> -U0` in work-driver-verify-develop-gates.ts — which is not
      //     this module's argv and which a name-based `-c filter.<name>.clean`
      //     cannot neutralise for a name the child chose. Attributing that read
      //     to this guard (or blaming this guard for it) would be wrong either
      //     way; the `foreign` case below pins its exposure explicitly.
      rmSync(marker, { force: true });
      await readBothGuardedReads(dir, base);
      const directRan = existsSync(marker);

      // (c) The gate still sees the protected file. A hardening that silently
      //     blinded the read would look like (b) passing and this failing, so
      //     the two assertions are only meaningful together.
      const res = await verifyStepOutcome(developCtx(), developState(dir, base), "develop");
      if (opts.guarded) {
        assert(
          !directRan,
          `${opts.label}: the two guarded reads never execute the child's script (filter name \`${opts.filterName}\` is one the argv forces off)`,
        );
        assert(
          protectedFailure(res.failures).includes(`— ${CI}`),
          `${opts.label}: ...and the gate still HALTS on the protected file (the guard did not blind the read)`,
        );
      } else {
        // The documented limit, asserted rather than narrated: a filter whose
        // name the argv does not name still runs. If git ever grows a real
        // wildcard this assertion fails and the jsdoc gets to claim more.
        assert(
          directRan,
          `${opts.label}: DOCUMENTED LIMIT — a filter named \`${opts.filterName}\`, which the argv does not name, still runs. The guard is per-name, not blanket (see the module jsdoc)`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const tracked = (dir: string, name: string) => {
    // Committed: survives every `-c` that only redirects the worktree-level file.
    writeFileSync(path.join(dir, ".gitattributes"), `*.yml filter=${name}\n`);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "commit the attribute binding"]);
  };
  const untracked = (dir: string, name: string) => {
    // Untracked, so the read could not remove the binding even if it wanted to.
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "info", "attributes"), `*.yml filter=${name}\n`);
  };

  for (const name of GUARDED_NAMES) {
    await bindCase({
      label: `committed .gitattributes + filter.${name}.clean`,
      bind: (d) => tracked(d, name),
      filterName: name,
      guarded: true,
    });
    await bindCase({
      label: `.git/info/attributes + filter.${name}.clean`,
      bind: (d) => untracked(d, name),
      filterName: name,
      guarded: true,
    });
  }

  // The limit, in both attribute locations.
  await bindCase({
    label: "committed .gitattributes + an unguarded filter name",
    bind: (d) => tracked(d, "childchose"),
    filterName: "childchose",
    guarded: false,
  });
  await bindCase({
    label: ".git/info/attributes + an unguarded filter name",
    bind: (d) => untracked(d, "childchose"),
    filterName: "childchose",
    guarded: false,
  });

  // The sibling read this module does NOT own, pinned so the gap is visible.
  //
  // `verifyStepOutcome("develop")` also runs the skip-ratchet's content diff —
  // `git diff <base> -U0` in work-driver-verify-develop-gates.ts. It is a
  // content diff, so it DOES reach the clean filter, and it is not one of the
  // two argv constants hardened here. Measured: with a child-written filter
  // bound by name, that read runs the script while both guarded reads stay
  // clean. `--no-ext-diff`/`--no-textconv` do not help (they silence an
  // external-diff/textconv driver, not a clean filter) — only
  // `-c filter.<name>.clean=false` does, for a name the child controls. Recorded
  // here because a passing guard next to an unguarded sibling is exactly the
  // arrangement that gets mistaken for coverage.
  {
    const root = mkdtempSync(path.join(tmpdir(), "protect-foreign-"));
    try {
      const dir = path.join(root, "wt");
      mkdirSync(dir, { recursive: true });
      const base = seedRepo(dir);
      const script = path.join(dir, "evil-filter.sh");
      const marker = path.join(dir, "FOREIGN_RAN");
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexec cat\n`);
      chmodSync(script, 0o755);
      mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
      writeFileSync(path.join(dir, ".git", "info", "attributes"), "*.yml filter=childchose\n");
      gitIn(dir, ["config", "filter.childchose.clean", script]);
      writeFileSync(path.join(dir, CI), "runs-on: ubuntu\nchild-wrote-this\n");
      rmSync(marker, { force: true });
      await readBothGuardedReads(dir, base);
      // Both guarded reads run a `filter.childchose` they cannot force off, so
      // the honest expectation is the opposite of the guarded cases: the script
      // DOES run. That is the limit, and it is what makes the guarded cases'
      // `!existsSync` meaningful — the same fixture shape, the only difference
      // being whether the argv names the filter.
      const foreignRan = existsSync(marker);
      assert(
        foreignRan,
        "the documented limit, isolated to these two reads: a filter name the argv does not name DOES run under them (per-name guard, not blanket)",
      );
      gitIn(dir, ["diff", base, "-U0"]);
      assert(
        existsSync(marker),
        "…and the develop gate's separate skip-ratchet content diff (`git diff <base> -U0`, NOT this module's argv) runs it too — that read is owned elsewhere, see the block comment",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // A `diff=<x>.textconv` driver: measured NEVER to run on either guarded read
  // (nor on an unguarded `--name-status` read) — no content is emitted, so no
  // textconv is consulted. Asserted so a future `-p`/content-shaped read cannot
  // quietly make it reachable without someone noticing.
  {
    const root = mkdtempSync(path.join(tmpdir(), "protect-textconv-"));
    try {
      const dir = path.join(root, "wt");
      mkdirSync(dir, { recursive: true });
      const base = seedRepo(dir);
      const script = path.join(dir, "evil-textconv.sh");
      const marker = path.join(dir, "TEXTCONV_RAN");
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nprintf 'x\\n'\n`);
      chmodSync(script, 0o755);
      writeFileSync(path.join(dir, ".gitattributes"), "*.yml diff=x text=yes\n");
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "commit the textconv binding"]);
      gitIn(dir, ["config", "diff.x.textconv", script]);
      writeFileSync(path.join(dir, CI), "runs-on: ubuntu\nchild-wrote-this\n");
      rmSync(marker, { force: true });
      await readBothGuardedReads(dir, base);
      const textconvRan = existsSync(marker);
      const res = await verifyStepOutcome(developCtx(), developState(dir, base), "develop");
      assert(
        !textconvRan,
        "a committed `diff=x` + `diff.x.textconv` driver never runs for either guarded read (a --name-status read emits no content, so textconv is never consulted)",
      );
      assert(
        protectedFailure(res.failures).includes(`— ${CI}`),
        "...and that read still HALTS on the protected file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


console.log(`\nexit ${exit}`);
process.exit(exit);
