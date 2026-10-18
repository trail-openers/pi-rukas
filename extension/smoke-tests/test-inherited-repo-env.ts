#!/usr/bin/env bun
/**
 * #1571 — an inherited git location variable must not reach a child.
 *
 * With `GIT_DIR=<main>/.git` and no `GIT_WORK_TREE`, git run from a linked
 * worktree takes the MAIN checkout's index and exits 0: a child's `git add`
 * or `git reset` lands in another session's tree. The canary below proves
 * that retarget on real git (so the rest cannot pass vacuously); then it
 * checks that `scrubGitLocation` removes it and that both child-spawn sites
 * — spawn.ts and the resume reattach — hand the child a scrubbed env, and
 * that the extension scrubs its own process env for the driver's git calls.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { dispatchCore } from "../src/dispatch.ts";
import { GIT_LOCATION_VARS, scrubGitLocation } from "../src/git-env.ts";
import { attemptReattach } from "../src/work-driver-resume-reattach.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(path.join(tmpdir(), "git-location-env-"));
const clean: Record<string, string | undefined> = { ...process.env };
for (const k of Object.keys(clean)) if (k.startsWith("GIT_")) delete clean[k];
const git = (cwd: string, env: Record<string, string | undefined>, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

try {
  // ── Real git: the retarget, and the scrub that prevents it ───────────
  const main = path.join(dir, "main");
  const wt = path.join(dir, "wt");
  git(dir, clean, "init", "-q", main);
  git(
    main,
    clean,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  git(main, clean, "worktree", "add", "-q", "--detach", wt);
  writeFileSync(path.join(wt, "child-edit.txt"), "x\n");

  const inherited = { ...clean, GIT_DIR: path.join(main, ".git") };
  git(wt, inherited, "add", "child-edit.txt");
  const mainStaged = git(main, clean, "diff", "--cached", "--name-only");
  assert(
    mainStaged === "child-edit.txt",
    "canary: GIT_DIR without GIT_WORK_TREE stages a worktree's file in the MAIN index",
  );
  git(main, clean, "reset", "-q");

  const scrubbed = { ...inherited };
  assert(
    scrubGitLocation(scrubbed).join(",") === "GIT_DIR" && !("GIT_DIR" in scrubbed),
    "scrubGitLocation removes GIT_DIR and reports it",
  );
  git(wt, scrubbed, "add", "child-edit.txt");
  assert(
    git(main, clean, "diff", "--cached", "--name-only") === "",
    "scrubbed: the main checkout's index is untouched",
  );
  assert(
    git(wt, clean, "diff", "--cached", "--name-only") === "child-edit.txt",
    "scrubbed: the edit is staged in the worktree's own index",
  );

  const all: Record<string, string | undefined> = { GIT_EDITOR: "true", GIT_CONFIG_COUNT: "1" };
  for (const name of GIT_LOCATION_VARS) all[name] = "/elsewhere";
  scrubGitLocation(all);
  assert(
    GIT_LOCATION_VARS.every((n) => !(n in all)) &&
      all.GIT_EDITOR === "true" &&
      all.GIT_CONFIG_COUNT === "1",
    "every location variable goes; GIT_EDITOR and the -c config channel stay",
  );

  // ── spawn.ts: the child process gets a scrubbed env ──────────────────
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
  const envFile = path.join(dir, "child.env");
  const stub = path.join(dir, "pi-stub.sh");
  writeFileSync(
    stub,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }\nenv > "${envFile}.tmp" && mv "${envFile}.tmp" "${envFile}"\n`,
  );
  chmodSync(stub, 0o755);
  const poison = {
    GIT_DIR: path.join(main, ".git"),
    GIT_WORK_TREE: main,
    GIT_INDEX_FILE: path.join(main, ".git", "index"),
    PI_ENSEMBLE_PI_BIN: stub,
  };
  await withEnv(poison, async () => {
    const host: DispatchHost = { sendUserMessage: () => {} };
    const done = dispatchCore(
      host,
      { role: "developer", prompt: "stub", cwd: wt },
      { skipDeck: true },
    );
    const end = Date.now() + 10_000;
    while (!existsSync(envFile) && Date.now() < end) await sleep(20);
    await Promise.race([done.catch(() => undefined), sleep(10_000)]);
  });
  const childEnv = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  assert(/^GIT_EDITOR=true$/m.test(childEnv), "the stub child ran and recorded its env");
  assert(
    !/^GIT_(DIR|WORK_TREE|INDEX_FILE)=/m.test(childEnv),
    "spawn.ts: no inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE reaches the child",
  );

  // ── resume reattach: the second child-env construction site ──────────
  let reattachEnv: Record<string, string> = {};
  await withEnv({ GIT_DIR: path.join(main, ".git") }, async () => {
    await attemptReattach("/tmp/none.json", "develop", "developer", 1_000, async (_a, env) => {
      reattachEnv = env;
      return { exitCode: 1, stdout: "", stderr: "" };
    });
  });
  assert(
    Object.keys(reattachEnv).length > 0 && !("GIT_DIR" in reattachEnv),
    "reattach: the child env carries no inherited GIT_DIR",
  );

  // ── each process entry scrubs its own env for the driver's direct git calls ──
  for (const entry of ["index.ts", "headless/cli.ts"]) {
    const src = readFileSync(path.join(import.meta.dirname, "..", "src", entry), "utf8");
    assert(
      /scrubGitLocation\(process\.env\)/.test(src),
      `${entry} scrubs process.env, covering every driver git call in that process`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exit);
