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
 *    exit non-zero naming the missing module, with every previously published
 *    prompt byte-identical and no `.tmp-*` straggler left behind — in the
 *    output dir **or** in the copied `agents-base/`, where the capabilities
 *    writer puts its own temp. The abort lands mid-loop: a module only a
 *    later-built agent references is removed, so the earlier prompts publish
 *    and the loop dies partway. That is the path that used to leak, because the
 *    capabilities function ran inside a command substitution where its
 *    `_track_temp` writes died with the subshell and its own `trap` had
 *    replaced the run-wide one.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

/** Run build.sh with BASE/PROMPTS_DIR overridden; resolve with its exit code
 *  and its merged stderr/stdout, which the abort arm reads for the module it
 *  named. Output is captured to a file rather than a pipe so a verbose build
 *  log cannot fill the OS buffer and wedge the child. */
function runBuild(
  base: string,
  promptsDir: string,
  logPath?: string,
): Promise<{code: number; log: string}> {
  return new Promise((resolve, reject) => {
    const fd = logPath === undefined ? undefined : openSync(logPath, "w");
    const child = spawn("bash", [BUILD], {
      cwd: ROOT,
      env: { ...process.env, PI_ENSEMBLE_BASE: base, PROMPTS_DIR: promptsDir },
      stdio: fd === undefined ? "ignore" : ["ignore", fd, fd],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (fd !== undefined) closeSync(fd);
      const log = logPath !== undefined && existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      resolve({code: code ?? -1, log});
    });
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
    const build = runBuild(base, prompts, path.join(scratch, "arm1.log")).then((r) => {
      done = true;
      return r;
    });
    // Poll the watched file for the whole life of the build. A file that is
    // missing between the build's rm and its rewrite is counted, not retried.
    while (!done) {
      if (!existsSync(watched)) misses++;
      polls++;
      await sleep(20);
    }
    const {code} = await build;

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

    const pre = await runBuild(base, prompts, path.join(scratch, "arm2-pre.log"));
    assert(pre.code === 0, `arm 2: pre-abort build exited 0`);
    const publishedDir = path.join(prompts, "standard");
    const before = new Map(
      readdirSync(publishedDir).map((f) => [
        f,
        readFileSync(path.join(publishedDir, f), "utf8"),
      ]),
    );
    assert(before.size === AGENTS.length, `arm 2: ${AGENTS.length} prompts published`);

    // Break the build the way a missing module does, and break it MID-LOOP:
    // the capabilities matrix is referenced by the last-built manifest only, so
    // the earlier agents publish and the loop dies partway through. That is
    // where the run's EXIT trap has to reach: some prompts are already
    // published, some have a half-assembled temp beside them, and the
    // capabilities writer has a temp of its own in the copied agents-base/.
    const removed = path.join(base, "modules", "core", "async-tasks.md");
    assert(
      existsSync(removed) && statSync(removed).isFile(),
      "arm 2: modules/core/async-tasks.md exists to be removed (the mid-loop seed)",
    );
    rmSync(removed);
    const aborted = await runBuild(base, prompts, path.join(scratch, "arm2-abort.log"));
    assert(aborted.code !== 0, `arm 2: build.sh exited non-zero on the missing module`);

    // The abort must say WHAT it could not find, not merely fail.
    assert(
      /ERROR/.test(aborted.log) && /async-tasks\.md/.test(aborted.log),
      `arm 2: the aborted build named the missing module${
        /async-tasks\.md/.test(aborted.log) ? "" : ` (captured output: ${aborted.log.slice(0, 240)})`
      }`,
    );

    const stragglers = readdirSync(publishedDir).filter((f) => f.includes(".tmp-"));
    assert(
      stragglers.length === 0,
      `arm 2: no .tmp-* left behind in the output dir by the aborted build${stragglers.length ? ` (${stragglers.join(", ")})` : ""}`,
    );
    // The capabilities writer's own temp lives beside the copied base files.
    const agentsBase = path.join(base, "agents-base");
    const baseStragglers = readdirSync(agentsBase).filter((f) => f.includes(".tmp"));
    assert(
      baseStragglers.length === 0,
      `arm 2: the aborted build left no *.tmp* in the copied agents-base/${baseStragglers.length ? ` (${baseStragglers.join(", ")})` : ""}`,
    );
    const after = readdirSync(publishedDir);
    const unchanged =
      after.length === before.size &&
      after.every((f) => before.get(f) === readFileSync(path.join(publishedDir, f), "utf8"));
    assert(unchanged, "arm 2: an aborted build leaves every published prompt byte-identical");
  }

  // --- Arm 3: an abort INSIDE the capabilities writer leaves nothing. -------
  // Arms 1 and 2 abort in the parent's module loop, where the build never gets
  // as far as writing a capabilities temp. This arm aborts in the writer itself,
  // which is the only place the temp's ownership is decided: `target_tmp` is
  // created inside a command substitution, so the writer cannot hand it to a
  // parent array (the assignment dies with the subshell) and must not install a
  // trap of its own (only one EXIT trap exists, and the writer's would be the
  // one that runs). The writer's temp is therefore named with the parent's `$$`
  // and reclaimed by the parent's trap — which is what this arm measures.
  //
  // The writer fails on an agent `agents.json` does not name: the first agent
  // publishes, the second aborts, and no third agent is reached.
  {
    const base = path.join(scratch, "tree-caps");
    const prompts = path.join(scratch, "caps-abort");
    copyTree(base);
    mkdirSync(path.join(prompts, "standard"), { recursive: true });

    const seed = await runBuild(base, prompts, path.join(scratch, "arm3-seed.log"));
    assert(seed.code === 0, "arm 3: seed build exited 0");
    const publishedDir = path.join(prompts, "standard");
    const before = new Map(
      readdirSync(publishedDir).map((f) => [
        f,
        readFileSync(path.join(publishedDir, f), "utf8"),
      ]),
    );

    const configPath = path.join(base, "agents.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      agent: Record<string, unknown>;
    };
    // The doomed agent: the last specialist the sorted manifest order visits,
    // so the loop publishes at least one prompt before it dies.
    const candidates = AGENTS.filter((a) => a !== "project-manager");
    const doomed = candidates[candidates.length - 1];
    assert(
      doomed !== undefined &&
        doomed !== "project-manager" &&
        Object.prototype.hasOwnProperty.call(config.agent, doomed),
      `arm 3: '${doomed ?? "<none>"}' is an agent in agents.json (the doomed one)`,
    );
    if (doomed === undefined || !Object.prototype.hasOwnProperty.call(config.agent, doomed)) {
      throw new Error(`arm 3: cannot resolve a doomed agent from ${AGENTS.join(", ")}`);
    }
    delete config.agent[doomed];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const aborted = await runBuild(base, prompts, path.join(scratch, "arm3-abort.log"));
    assert(aborted.code !== 0, "arm 3: build.sh exited non-zero on the unknown agent");
    assert(
      /ERROR/.test(aborted.log) && aborted.log.includes(doomed),
      `arm 3: the aborted build named the agent it could not resolve${aborted.log.includes(doomed) ? "" : ` (captured output: ${aborted.log.slice(0, 240)})`}`,
    );

    const outStragglers = readdirSync(publishedDir).filter((f) => f.includes(".tmp"));
    assert(
      outStragglers.length === 0,
      `arm 3: no .tmp* left in the output dir by the capabilities abort${outStragglers.length ? ` (${outStragglers.join(", ")})` : ""}`,
    );
    const baseStragglers = readdirSync(path.join(base, "agents-base")).filter((f) =>
      f.includes(".tmp"),
    );
    assert(
      baseStragglers.length === 0,
      `arm 3: the capabilities temp was reclaimed from agents-base/ by the aborted build${baseStragglers.length ? ` (${baseStragglers.join(", ")})` : ""}`,
    );
    const after = readdirSync(publishedDir);
    assert(
      after.length === before.size &&
        after.every((f) => before.get(f) === readFileSync(path.join(publishedDir, f), "utf8")),
      "arm 3: a capabilities abort leaves every previously published prompt byte-identical",
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
