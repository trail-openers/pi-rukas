#!/usr/bin/env bun
/**
 * #2430 — build.sh publishes a prompt by rename, never by delete-then-rewrite.
 *
 * build.sh used to `rm -f "$OUTPUT_DIR"/*.txt "$OUTPUT_DIR"/*.md` and then
 * recreate each `$OUTPUT_DIR/<agent>.md` empty (`> "$output"`) before appending
 * its modules, so for ~1s a published prompt did not exist. Readers that share
 * the verify pool with a builder (test-command-flow.ts, test-developer-commit-
 * doctrine.ts), and the production spawn read at `src/spawn.ts`, ENOENTed. The
 * fix is in the writer: assemble into `<agent>.md.tmp-<pid>` beside the target
 * and `mv -f` onto it as the sole publish step.
 *
 * Two arms, both run against a PROMPTS_DIR this test owns and a copied module
 * tree, so neither disturbs the checkout's real dist/ or its sources:
 *
 * 1. **No gap.** Seed every agent prompt, run build.sh in the background while
 *    polling one of them at ~20 ms, and require ZERO missing observations. The
 *    build's exit code is asserted separately, so an aborted build cannot read
 *    as a clean poll (a build that died early polls green without ever having
 *    published anything).
 * 2. **An abort destroys nothing.** Copy the module tree to a temp dir, publish
 *    a full set, remove one manifest-referenced module, rerun: the build must
 *    exit non-zero with every previously published prompt byte-identical and no
 *    `.tmp-*` straggler left behind.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUILD = path.join(ROOT, "build.sh");
const AGENTS = readdirSync(path.join(ROOT, "manifests"))
  .filter((n) => n.endsWith(".manifest"))
  .map((n) => n.replace(/\.manifest$/, ""));
const POLL_TARGET = "project-manager.md";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run build.sh with BASE/PROMPTS_DIR overridden; resolve with its exit code. */
function runBuild(base: string, promptsDir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bash", [BUILD], {
      cwd: ROOT,
      env: { ...process.env, PI_ENSEMBLE_BASE: base, PROMPTS_DIR: promptsDir },
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** Copy the inputs build.sh reads (never dist/) into a private tree. */
function copyTree(dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const dir of ["modules", "manifests", "agents-base"]) {
    const walk = (rel: string) => {
      const abs = path.join(ROOT, rel);
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(rel, entry.name));
        else {
          const target = path.join(dest, rel, entry.name);
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(path.join(ROOT, rel, entry.name), target);
        }
      }
    };
    walk(dir);
  }
  copyFileSync(path.join(ROOT, "agents.json"), path.join(dest, "agents.json"));
}

const scratch = mkdtempSync(path.join(tmpdir(), "build-atomic."));

try {
  // --- Arm 1: a concurrent reader never sees a prompt missing. -------------
  {
    const base = path.join(scratch, "tree");
    const prompts = path.join(scratch, "live");
    // Sources are copied so the poll overlaps the real module-assembly loop
    // while the abort arm can still break a module out of the same tree.
    copyTree(base);
    mkdirSync(path.join(prompts, "standard"), { recursive: true });
    for (const agent of AGENTS) {
      writeFileSync(path.join(prompts, "standard", `${agent}.md`), "seed\n");
    }
    const watched = path.join(prompts, "standard", POLL_TARGET);

    let misses = 0;
    let polls = 0;
    let done = false;
    const build = runBuild(base, prompts).then((code) => {
      done = true;
      return code;
    });
    // Poll the watched file for the whole life of the build. A file that is
    // missing between the build's rm and its rewrite is counted, not retried.
    while (!done) {
      if (!existsSync(watched)) misses++;
      polls++;
      await sleep(20);
    }
    const code = await build;

    // The build's exit code is a separate assertion: a build that died early
    // would leave the seeded files untouched and poll green.
    assert(code === 0, "arm 1: build.sh exited 0");
    assert(polls > 5, `arm 1: the poll actually overlapped the build (${polls} polls)`);
    assert(
      misses === 0,
      `${POLL_TARGET} never missing while build.sh ran (${misses} of ${polls} polls)`,
    );
  }

  // --- Arm 2: an aborted build leaves the published set untouched. ---------
  {
    const base = path.join(scratch, "tree");
    const prompts = path.join(scratch, "abort");
    mkdirSync(path.join(prompts, "standard"), { recursive: true });

    const pre = await runBuild(base, prompts);
    assert(pre === 0, `arm 2: pre-abort build exited 0`);
    const publishedDir = path.join(prompts, "standard");
    const before = new Map(
      readdirSync(publishedDir).map((f) => [
        f,
        readFileSync(path.join(publishedDir, f), "utf8"),
      ]),
    );
    assert(before.size === AGENTS.length, `arm 2: ${AGENTS.length} prompts published`);

    // Break the build the way a missing module does: one manifest reference now
    // resolves to nothing.
    const removed = path.join(base, "modules", "core", "codemode.md");
    rmSync(removed);
    const aborted = await runBuild(base, prompts);
    assert(aborted !== 0, `arm 2: build.sh exited non-zero on the missing module`);

    const stragglers = readdirSync(publishedDir).filter((f) => f.includes(".tmp-"));
    assert(
      stragglers.length === 0,
      `arm 2: no .tmp-* left behind by the aborted build${stragglers.length ? ` (${stragglers.join(", ")})` : ""}`,
    );
    const after = readdirSync(publishedDir);
    const unchanged =
      after.length === before.size &&
      after.every((f) => before.get(f) === readFileSync(path.join(publishedDir, f), "utf8"));
    assert(unchanged, "arm 2: an aborted build leaves every published prompt byte-identical");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
