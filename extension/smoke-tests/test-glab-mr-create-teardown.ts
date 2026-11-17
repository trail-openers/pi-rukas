#!/usr/bin/env bun
/**
 * #2342 — the `glab mr create` teardown takes back EVERY directory its own env
 * builder allocated, and only those.
 *
 * `glabCreateEnv()` funnels through `forgeReadChildEnv`, which mkdtemps a private
 * `pi-rukas-forge-XXXXXX` parent and an empty `pi-rukas-forge-config-*` dir inside
 * it. A spawn's teardown removes a child's dir when the child exits; a create is a
 * driver exec that outlives nothing, so nothing else ever took either back, and a
 * create leaked two directories per MR for the life of the host — the inner one
 * first, and (once that was fixed) the parent no one but this module could name.
 *
 * The assertions are read while the create still HOLDS the directories, not after
 * it: an exec fake that resolves on the microtask queue lets the create's `finally`
 * run before any `existsSync` below, so every "it is gone now" also passes on a
 * create that removed nothing. So the fake plants a file in each directory (which is
 * what a removal actually has to overcome) and waits on a promise only this test
 * resolves.
 *
 * Split from `test-child-forge-env.ts` at that seam: that file is the child env and
 * the broker role gate; this one is the create's teardown.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  FORGE_CONFIG_DIR_VARS,
  glabCreateEnv,
  removeGlabCreateEnvDirs,
} from "../src/child-forge-env.ts";
import { createForge } from "../src/forge.ts";
import type { ForgeExecFn } from "../src/forge-types.ts";
import { glDetection } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

async function main(): Promise<void> {
  console.log("glab mr create teardown:");

  await check(
    "a GitLab MR create removes the forge config dir it handed the exec",
    () => {
      // `glabCreateEnv()` mkdtemps an EMPTY forge-config dir on EVERY GitLab
      // create (it is the same builder a spawn uses, and it allocates the dir
      // eagerly). The create is a driver exec that outlives nothing, so a create
      // that never removed its dir leaked one directory per MR into the temp root
      // for the life of the host — and one more, one level up, for the `mkdtemp`
      // PARENT that `createChildForgeConfigDir` makes when it is called without a
      // `root` and whose name no one but this module holds.
      //
      // Both are counted here, and the counting is only honest because of HOW the
      // exec holds the create open. A fake that resolves on the microtask queue
      // lets the create's `finally` run before any read below, so every "it is gone
      // now" passes on a create that removed nothing — and every "it was there
      // before" is read after the fact. So the exec plants a file in each directory
      // it was handed (making them NON-EMPTY, which is what a removal has to
      // actually overcome) and then waits on a promise only this test resolves.
      type Snapshot = {
        dirs: string[];
        parents: string[];
        planted: string[];
        dirsLive: boolean[];
        parentsLive: boolean[];
        plantedLive: boolean[];
      };
      const seen: Record<string, string>[] = [];
      const inFlight: Snapshot[] = [];
      let releaseExec: (() => void) | undefined;
      let held: string[] = [];
      const fn: ForgeExecFn = async (_cmd, opts) => {
        const env = (opts?.env ?? {}) as Record<string, string>;
        seen.push(env);
        const dirs = FORGE_CONFIG_DIR_VARS.map((k) => env[k]).filter(
          (d): d is string => !!d && d.includes("pi-rukas-forge-"),
        );
        const parents = dirs.map((d) => dirname(d));
        const planted: string[] = [];
        for (const d of new Set([...dirs, ...parents])) {
          const f = join(d, `planted-${planted.length}`);
          writeFileSync(f, "the create still holds this", "utf8");
          planted.push(f);
        }
        inFlight.push({
          dirs,
          parents,
          planted,
          dirsLive: dirs.map((d) => existsSync(d)),
          parentsLive: parents.map((p) => existsSync(p)),
          plantedLive: planted.map((f) => existsSync(f)),
        });
        // Held open on a MACROTASK this test resolves — see the header.
        await new Promise<void>((resolve) => {
          releaseExec = resolve;
        });
        return { stdout: "https://gitlab.com/acme/widget/-/merge_requests/17\n" };
      };
      const forge = createForge(glDetection("acme", "widget"), { execFn: fn });

      const started = forge.prCreate("feat(x): y", "feature/branch", "a body", {
        baseBranch: "main",
      });

      // Wait for the exec to have reached the create, still holding it open, then
      // read the directories once the create has been allowed to finish. The two
      // reads are what separate "removed" from "never there".
      const hold = new Promise<void>((resolveHold) => {
        const poll = setInterval(() => {
          if (inFlight.length === 0) return;
          clearInterval(poll);
          const shot = inFlight[0] as Snapshot;
          assert(shot !== undefined, "the create reached exec with an env");
          assert(
            shot.dirs.length > 0 && shot.dirsLive.every(Boolean),
            `the config dir existed WHILE the create was in flight (${JSON.stringify([shot.dirs, shot.dirsLive])})`,
          );
          assert(
            shot.parents.length > 0 && shot.parentsLive.every(Boolean),
            `and so did its mkdtemp parent (${JSON.stringify([shot.parents, shot.parentsLive])})`,
          );
          assert(
            shot.planted.length > 0 && shot.plantedLive.every(Boolean),
            `the files planted in them were there too (${JSON.stringify([shot.planted, shot.plantedLive])})`,
          );
          assert(
            shot.parents.every((p) => dirname(shot.dirs[0] as string) === p),
            "the config dir the child was given sits INSIDE that parent",
          );
          held = [...shot.dirs, ...shot.parents, ...shot.planted];
          releaseExec?.();
          resolveHold();
        }, 5);
      });
      return hold.then(async () => {
        await started;
        // Everything the create allocated is gone, INCLUDING the parent and the
        // files planted inside it: the planted files made each directory non-empty,
        // so a teardown that skipped a path leaves it standing and this row names it.
        const stillThere = held.filter((p) => existsSync(p));
        assert(
          stillThere.length === 0,
          `the create removed its config dir, its mkdtemp parent and their contents (${stillThere.join(",")})`,
        );
      });
    },
  );
  await check(
    "and it removes the dir when the create fails too",
    () => {
      const seen: Record<string, string>[] = [];
      // Same hold-and-plant discipline as the success path: a create that REJECTS
      // still allocated both directories, and its `finally` is the only thing that
      // takes them back. Without the hold, this row reads them after the `finally`
      // either way and cannot tell a teardown from a leak.
      const inFlight: { all: string[]; live: boolean[] }[] = [];
      let releaseExec: (() => void) | undefined;
      let paths: string[] = [];
      const fn: ForgeExecFn = async (_cmd, opts) => {
        const env = (opts?.env ?? {}) as Record<string, string>;
        seen.push(env);
        const dirs = FORGE_CONFIG_DIR_VARS.map((k) => env[k]).filter(
          (d): d is string => !!d && d.includes("pi-rukas-forge-"),
        );
        const all = [...new Set([...dirs, ...dirs.map((d) => dirname(d))])];
        const planted: string[] = [];
        for (const d of all) {
          const f = join(d, `planted-${planted.length}`);
          writeFileSync(f, "x", "utf8");
          planted.push(f);
        }
        const every = [...all, ...planted];
        inFlight.push({ all: every, live: every.map((p) => existsSync(p)) });
        await new Promise<void>((resolve) => {
          releaseExec = resolve;
        });
        return { stdout: "glab said no\n" };
      };
      const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
      const started = forge.prCreate("feat(x): y", "feature/branch", "a body", {});
      const hold = new Promise<void>((resolveHold) => {
        const poll = setInterval(() => {
          if (inFlight.length === 0) return;
          clearInterval(poll);
          const shot = inFlight[0];
          assert(shot !== undefined, "the failed create reached exec with an env");
          assert(
            shot.all.length > 0 && shot.live.every(Boolean),
            `both dirs and their contents existed while the failed create held them (${JSON.stringify([shot.all, shot.live])})`,
          );
          paths = shot.all;
          releaseExec?.();
          resolveHold();
        }, 5);
      });
      return hold.then(async () => {
        let rejected = false;
        await started.catch(() => {
          rejected = true;
        });
        assert(rejected, "a reply with no URL line must reject");
        const stillThere = paths.filter((p) => existsSync(p));
        assert(
          stillThere.length === 0,
          `a failed create removes its config dir, its mkdtemp parent and their contents (${stillThere.join(",")})`,
        );
      });
    },
  );
  await check(
    "the teardown removes only the paths it was given, never a path it inferred",
    () => {
      // A directory someone else owns that merely CARRIES this module's prefix in
      // its name is not this module's to delete. The predecessor of this teardown
      // removed on a substring of the env value, which is the difference between
      // deleting one's own temp dir and deleting a tree chosen by name.
      const foreign = join(tmpdir(), "pi-rukas-forge-not-mine");
      rmSync(foreign, { recursive: true, force: true });
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, "keep"), "not yours", "utf8");
      removeGlabCreateEnvDirs([]);
      assert(
        existsSync(join(foreign, "keep")),
        "an owned list naming nothing removes nothing, not even a dir named like this module's",
      );
      rmSync(foreign, { recursive: true, force: true });
    },
  );
  await forgeExitCode("the glab create teardown removes what it allocated, and nothing else");
}

await main();
