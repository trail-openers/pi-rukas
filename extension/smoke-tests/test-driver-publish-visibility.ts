#!/usr/bin/env bun
/**
 * test-driver-publish-visibility.ts — the driver's OWN publish checks honour the
 * public-only gate (#1788 round 2, lens finding 1).
 *
 * The `tool_call` guard asks which repository a publish writes to and skips a
 * private one. The driver's writes do not pass through that hook — a forge post
 * and the direct-exec merge are in-process execs — so they carried their own
 * check, and both versions of that check asked nothing about the repository. A
 * downstream factory working in a PRIVATE repository therefore had its PR bodies,
 * comments and merge subjects refused on the operator's private list: not
 * privacy, and exactly the friction that gets the whole guard switched off for
 * the repositories that do publish.
 *
 * Three cases, one per visibility answer, on the surface a private repository
 * actually notices (a PR body):
 *
 *   1. a POSITIVE private answer allows the dirty body through;
 *   2. a PUBLIC answer still refuses it — the gate skips only what it positively
 *      knows is private;
 *   3. a lookup that THROWS still refuses it — "could not tell" is never "clean".
 *
 * Every assertion also pins that nothing was posted: a check that runs after the
 * exec would report the same refusal one dispatch too late. Terms are synthetic
 * and the denylist is always a scratch file — this repository is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ForgeExecFn, createForge } from "../src/forge.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { ghDetection } from "./forge-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const DIRTY_BODY = `deployed on ${TERM} last night`;
const CLEAN_BODY = "deployed on the staging box last night";

const dir = mkdtempSync(path.join(tmpdir(), "driver-publish-visibility-"));
const list = path.join(dir, "public-denylist");
writeFileSync(list, `# synthetic terms\n${TERM}\n`, "utf8");
const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: list };

/** A recording forge executor: it answers nothing and remembers everything. */
function recorder(): { fn: ForgeExecFn; calls: string[] } {
  const calls: string[] = [];
  const fn: ForgeExecFn = async (cmd, opts) => {
    calls.push(opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd);
    return { stdout: '{"number":17,"title":"t"}', stderr: "" };
  };
  return { fn, calls };
}

/** Build an adapter over a github.com remote whose visibility `answer` decides. */
function forgeOver(answer: (owner: string, repo: string) => Promise<boolean>) {
  const rec = recorder();
  const forge = createForge(ghDetection("acme", "widget"), {
    execFn: rec.fn,
    cwd: dir,
    visibility: async (t) => await answer(t.owner, t.repo),
  });
  return { forge, calls: rec.calls };
}

try {
  await withEnv(denylistEnv, async () => {
    // 1. PRIVATE: the same dirty body the public case refuses is posted. This is
    //    the whole point of the gate, and before this fix it did not hold — the
    //    driver checked every repository, private included.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    let asked = 0;
    const priv = forgeOver(async () => {
      asked += 1;
      return true;
    });
    const posted = await priv.forge.prCreate("ship it", "feature/x", DIRTY_BODY, {});
    assert(posted.number === 17, "a private repository posts a body with a listed term");
    assert(asked === 1, `and the gate asked the visibility question (asked ${asked})`);
    assert(
      priv.calls.some((c) => c.includes("pr create")),
      "the create really ran",
    );

    // 2. PUBLIC: the identical body is refused, and nothing is posted. The gate
    //    skips only what a lookup positively reported private.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const pub = forgeOver(async () => false);
    let thrown: unknown;
    try {
      await pub.forge.prCreate("ship it", "feature/x", DIRTY_BODY, {});
    } catch (err) {
      thrown = err;
    }
    assert(
      (thrown as { publicHygiene?: boolean })?.publicHygiene === true,
      `a public repository refuses the same body (threw ${String((thrown as Error)?.name ?? thrown).slice(0, 30)})`,
    );
    assert(
      !String((thrown as Error)?.message ?? "").includes(TERM),
      "and the refusal carries no term",
    );
    assert(
      pub.calls.every((c) => !c.includes("pr create")),
      "nothing was posted: the check runs before the command, not after it",
    );

    // 3. A lookup that THROWS is not an answer, so the body is still checked.
    //    This is the fail-closed direction: a failed lookup costs a checked
    //    private repo, the other direction costs a leak.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const broken = forgeOver(async () => {
      throw new Error("gh: connection reset");
    });
    let brokenThrown: unknown;
    try {
      await broken.forge.prCreate("ship it", "feature/x", DIRTY_BODY, {});
    } catch (err) {
      brokenThrown = err;
    }
    assert(
      (brokenThrown as { publicHygiene?: boolean })?.publicHygiene === true,
      "a failed visibility lookup checks the body rather than publishing it",
    );
    assert(
      broken.calls.every((c) => !c.includes("pr create")),
      "and a refused body posts nothing",
    );

    // 4. A CLEAN body on a public repository reaches the command: the gate never
    //    refuses what it should not, whichever way visibility resolved.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const clean = forgeOver(async () => false);
    const ok = await clean.forge.prCreate("ship it", "feature/x", CLEAN_BODY, {});
    assert(ok.number === 17, "a clean body on a public repository is posted");
    assert(
      clean.calls.some((c) => c.includes("pr create")),
      "and the command ran",
    );

    // 5. An issue body carries the same rule, because the driver files issues
    //    through the same adapter — one gate, not one gate per verb.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const issuePriv = forgeOver(async () => true);
    const made = await issuePriv.forge.issueCreate("title", DIRTY_BODY, {});
    assert(made.number === 17, "a private repository posts a dirty issue body too");
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const issuePub = forgeOver(async () => false);
    let issueThrown: unknown;
    try {
      await issuePub.forge.issueCreate("title", DIRTY_BODY, {});
    } catch (err) {
      issueThrown = err;
    }
    assert(
      (issueThrown as { publicHygiene?: boolean })?.publicHygiene === true,
      "and a public one is refused for the same body",
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
