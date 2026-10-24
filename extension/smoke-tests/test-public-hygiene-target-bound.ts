#!/usr/bin/env bun
/**
 * public-hygiene target bounds (#1792 final round) — the guard's `tool_call` hook
 * must answer, always. Every read it makes goes through a seam the CALLER
 * supplies, and a seam that never settles used to be able to hold the hook open
 * forever: the push scan sits behind `boundedScan`, the visibility question has
 * its own bound, but the repository-name lookup awaited `resolveCommandTarget`
 * with no wall clock at all.
 *
 * Two properties, and they pull in opposite directions:
 *
 * 1. a target seam that NEVER SETTLES still yields a verdict, and quickly — the
 *    session is not held open for a git that will not answer;
 * 2. the verdict that timeout produces is CHECK, not pass — an unnamed
 *    repository is not a private one, so a dirty body is refused. Timing out must
 *    never become the cheap way for a publish to skip the guard.
 *
 * The bound is read once at module load (`TARGET_RESOLVE_TIMEOUT_MS`), so the
 * direct helper is asked with its own `ms` — a fixture does not reach into
 * `process.env` and hope the module has not been loaded yet. The production
 * end-to-end leg below runs the guard's own default and therefore costs about ten
 * seconds of wall clock: that is the number an operator's `tool_call` actually
 * waits, and it is the only leg that proves the guard is the one holding the
 * seam.
 *
 * Terms are synthetic — this repository is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DenylistRead,
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import { TARGET_RESOLVE_TIMEOUT_MS, boundedTarget } from "../src/public-hygiene-bounds.ts";
import { inspectCommand } from "../src/public-hygiene-guard.ts";
import { type Target, isRepoTarget, resolveCommandTarget } from "../src/public-hygiene-target.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** The floor {@link boundedTarget}'s default carries, so a fixture bound below it
 * is refused rather than silently shortening the production wait. */
const SHORT_BOUND_MS = 1_000;

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-target-bound-"));
const denylistPath = path.join(dir, "denylist");
const TERM = "example-private-host";
writeFileSync(denylistPath, `# the operator list\n${TERM}\n`, "utf8");
const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

function deny(): DenylistRead {
  resetDenylistCacheForTests();
  return readPublicDenylist(denylistEnv);
}

const DIRTY_BODY = `gh pr create --title hi --body "deployed on ${TERM}"`;

/** Ask the guard with the target seam hung and the visibility cache empty, so
 * nothing but the bound can decide when this call returns. */
function askWithHungTarget(command: string) {
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();
  return inspectCommand(command, dir, undefined, deny, {
    pushVerb: ["pu", "sh"].join(""),
    // The seam the guard awaits when it has no executor: a promise that never
    // settles is exactly the fixture an `exec` that ignores its timeout is in
    // production.
    remoteUrl: () => new Promise<string>(() => undefined),
    // A resolver that would say PRIVATE is the outcome a timeout must not
    // accidentally enable: had the lookup been awaited forever, no verdict would
    // come at all; had it been treated as private, the body would pass.
    visibility: async () => true,
  });
}

// ── The helper on its own, with a short bound: the timeout is a VERDICT, not an
// error and not a pass. This is the leg that runs in about a second.
{
  const hung = () => new Promise<string>(() => undefined);
  const started = Date.now();
  const target = await boundedTarget(DIRTY_BODY, dir, undefined, hung, undefined, SHORT_BOUND_MS);
  const elapsed = Date.now() - started;
  assert(target === undefined, "a hung target lookup resolves to no name, not a thrown error");
  assert(
    elapsed < 5_000,
    `and it resolves at the bound rather than waiting on the seam (took ${elapsed} ms)`,
  );
  assert(
    TARGET_RESOLVE_TIMEOUT_MS === 10_000,
    `and production still waits the visibility question's ten seconds (got ${TARGET_RESOLVE_TIMEOUT_MS})`,
  );

  // The bound does not fire early: a seam that answers inside it is obeyed, so
  // the deadline is a ceiling and not the way the guard usually decides.
  const quick = async (): Promise<string> => "https://github.com/example-owner/example-repo.git";
  const answered = await boundedTarget(DIRTY_BODY, dir, undefined, quick, undefined, 30_000);
  assert(
    answered !== undefined && (answered as Target).owner === "example-owner",
    "a seam that answers within the bound still resolves the repository",
  );

  // A seam that REJECTS is handled inside the resolver, which returns an UNKNOWN
  // target rather than throwing — so the helper passes that non-repo target
  // through, and `isRepoTarget` is what turns it into "no name, therefore check".
  // Asserting `undefined` here would be asserting the wrong shape: the helper's
  // contract is "a name or no name", and an UnknownTarget IS no name.
  const boom = () => Promise.reject(new Error(`unreadable remote ${path.join(dir, "x")}`));
  const rejected = await boundedTarget(
    `git ${["pu", "sh"].join("")} origin main`,
    dir,
    undefined,
    boom,
    ["pu", "sh"].join(""),
    SHORT_BOUND_MS,
  );
  assert(
    rejected !== undefined && !isRepoTarget(rejected),
    "a seam that rejects yields no repository, which the guard reads as check",
  );

  // `resolveCommandTarget` itself is reachable with no seam and no executor, and
  // the helper must not swallow a name it was given.
  const plain = await resolveCommandTarget('gh pr create --title t', dir, undefined, {});
  assert(plain !== undefined, "the resolver answers its own default path");
}

await withEnv(denylistEnv, async () => {
  const started = Date.now();
  const decision = await askWithHungTarget(DIRTY_BODY);
  const elapsed = Date.now() - started;

  // 1. It answered. The bound is the only thing that could have produced a
  // return here, so this assertion IS the wall clock.
  assert(decision !== undefined, "a hung target seam still yields a verdict");
  assert(
    elapsed < 20_000,
    `and it answers inside the bound rather than waiting on the seam (took ${elapsed} ms)`,
  );
  // 2. The verdict is a refusal, and it is a refusal ABOUT THE BODY — the text
  // was checked, which is the fail-closed half of the property.
  const reason = decision?.reason ?? "";
  assert(reason !== "", "the hung lookup produced a refusal, not a pass");
  assert(reason.includes("body"), `and the refusal names the dirty surface (got "${reason}")`);
  assert(!reason.includes(TERM), "and the refusal never carries the private term");

  // 3. The clean case still works through the same hung seam: the bound is not a
  // blanket refusal, it is a decision to judge the text without a repository name.
  resetVisibilityCacheForTests();
  const clean = await inspectCommand(
    'gh pr create --title hi --body "a clean body"',
    dir,
    undefined,
    deny,
    {
      pushVerb: ["pu", "sh"].join(""),
      remoteUrl: () => new Promise<string>(() => undefined),
      visibility: async () => true,
    },
  );
  assert(clean === undefined, "a clean publish through a hung target seam still passes");
});

await withEnv(denylistEnv, async () => {
  // A seam that REJECTS is the same absence of a name as one that hangs: it must
  // not become an unhandled rejection or an implicit pass either.
  resetVisibilityCacheForTests();
  const rejected = await inspectCommand(DIRTY_BODY, dir, undefined, deny, {
    pushVerb: ["pu", "sh"].join(""),
    remoteUrl: () =>
      Promise.reject(new Error(`unreadable remote ${path.join(dir, "private-name")}`)),
    visibility: async () => true,
  });
  assert(rejected !== undefined, "a target seam that rejects still yields a verdict");
  assert(
    (rejected?.reason ?? "").includes("body"),
    "and a rejecting seam checks the dirty body rather than skipping it",
  );
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
