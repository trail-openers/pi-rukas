/**
 * test-merge-subject-public-hygiene.ts — the squash-subject check on the
 * driver's DIRECT merge exec path (#1788 round 4).
 *
 * `forge.ts` checks the subject a squash merge publishes before it execs; the
 * `merged` step has a second path that builds the same `gh pr merge … --subject`
 * command itself for the forge-undetermined case, and a check that lives only on
 * one of two paths is a check that can be bypassed by which branch the code took.
 * These assertions are the three ways that seam can be wrong: it checks nothing
 * (the term ships in a commit on main), it checks after the exec (the merge
 * lands and the refusal arrives too late), or it checks so eagerly that no merge
 * ever happens. The exec counter separates them.
 *
 * Terms are synthetic and the denylist is always a temp file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { PublicHygieneError } from "../src/public-hygiene-guard.ts";
import { publicTextRefusal } from "../src/public-hygiene-text.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { executeAndVerifyMerge } from "../src/work-driver-merged-mechanized.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");

/** A recording fake for the driver's shell-exec seam. */
function recording(): { exec: VerifyExecFn; calls: string[] } {
  const state: { calls: string[] } = { calls: [] };
  const exec: VerifyExecFn = async (cmd, opts) => {
    const full = opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;
    state.calls.push(full);
    // The pre-check must report OPEN (else the merge is skipped and an
    // order-of-checks assertion proves nothing) and the post-merge
    // verification must report MERGED (else the case ends in a warning note).
    // Both are `gh pr view … --json state`, so the answer turns on whether the
    // merge has been asked for yet — which is exactly the order under test.
    if (full.includes("pr view")) {
      return { stdout: state.calls.some((c) => c.includes("pr merge")) ? "MERGED\n" : "OPEN\n" };
    }
    return { stdout: "" };
  };
  return { exec, calls: state.calls };
}

const dir = mkdtempSync(path.join(tmpdir(), "merge-subject-"));
// The direct-exec fallback runs only when the forge cannot be determined, so
// the merge is driven in a directory with no repository to probe — the same
// shape the existing merged-step tests use. If a forge DID resolve, the merge
// would go through `forge.prMerge`, which already carried the check, and this
// file would report green while covering the path that was never broken.
const repoRoot = path.join(dir, "not-a-repo");
mkdirSync(repoRoot, { recursive: true });
const list = path.join(dir, "public-denylist");
writeFileSync(list, `# synthetic terms\n${TERM}\n`, "utf8");
const prev = process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = list;
// The denylist reader caches for the life of the process (an operator editing
// the file must not need a restart, so the cache keys on mtime and path). Every
// env change below therefore resets it, or the check would run against whatever
// list the first case read.
resetDenylistCacheForTests();
// The forge is forced unknown so these cases run the DIRECT-exec fallback —
// the path this file exists to cover. `forgeForCycle` otherwise builds a real
// adapter from a github.com remote and the merge goes through `forge.prMerge`,
// which already had the check; asserting on that path would leave the fallback
// untested while reporting green.
const prevForge = process.env.PI_ENSEMBLE_FORGE;
process.env.PI_ENSEMBLE_FORGE = "";

const NO_FORGE = async () => undefined;

try {
  // 1. A dirty subject is refused BEFORE anything is execed. The denylist is
  //    re-read per case (the reader caches on path and mtime, and a scratch file
  //    rewritten within a second keeps both), so every case states which list it
  //    expects to be judged against.
  resetDenylistCacheForTests();
  // The pre-check runs before the subject check does, so the observable claim is
  // the absence of the merge itself: `calls` legitimately holds the state probe
  // and the forge lookups that precede it. A merge that reached the exec would
  // appear here, and its absence is what distinguishes "refused first" from
  // "merged, then noticed".
  const dirty = recording();
  let thrown: unknown;
  // #1788 round 1: the refusal is a RESULT, not an exception. `runMerged` routes
  // on the discriminated return, so a throw past this contract is a step that
  // dies instead of a cycle that parks with the reason the guard gave.
  let dirtyResult: unknown;
  try {
    dirtyResult = await executeAndVerifyMerge(
      7,
      "squash",
      dirty.exec,
      repoRoot,
      `feat: ship ${TERM}`,
      NO_FORGE,
    );
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown === undefined,
    `a refused direct merge returns rather than throwing (threw ${String((thrown as Error)?.name ?? thrown).slice(0, 30)})`,
  );
  assert(
    (dirtyResult as { ok?: boolean })?.ok === false,
    "a squash subject with a private term is refused by the direct merge path",
  );
  const dirtyRefusal = (dirtyResult as { ok?: boolean; reason?: string })?.reason ?? "";
  assert(
    dirtyRefusal.includes("private-denylist entry matched"),
    "and the refusal is the hygiene refusal the driver's error paths already recognise",
  );
  assert(
    !String((thrown as Error)?.message ?? "").includes(TERM),
    "and its refusal carries no term",
  );
  assert(
    dirty.calls.every((c) => !c.includes("pr merge")),
    "nothing was execed: the check runs before the merge command, not after it",
  );

  // 2. A clean subject reaches the merge, with the subject on the command line.
  resetDenylistCacheForTests();
  const clean = recording();
  const result = await executeAndVerifyMerge(
    7,
    "squash",
    clean.exec,
    repoRoot,
    "feat(x): wire the build",
    NO_FORGE,
  );
  assert(
    (result as { merged?: boolean }).merged === true,
    "a clean subject still merges — the check refuses nothing it should not",
  );
  assert(
    clean.calls.some((c) => c.includes("--subject")) &&
      clean.calls.some((c) => c.includes("wire the build")),
    "and the subject it checked is the subject it published",
  );

  // 3. No subject at all is nobody's business to refuse (gh composes one).
  resetDenylistCacheForTests();
  const bare = recording();
  const bareResult = await executeAndVerifyMerge(
    7,
    "squash",
    bare.exec,
    repoRoot,
    undefined,
    NO_FORGE,
  );
  assert(
    (bareResult as { merged?: boolean }).merged === true,
    "a merge with no subject is not refused",
  );
  assert(
    bare.calls.some((c) => c.includes("pr merge")) &&
      !bare.calls.some((c) => c.includes("--subject")),
    "and no empty subject flag is added to the command",
  );

  // 4. The generic tier applies here as it does to every other public text
  //    surface (unlike a push's git-read texts, which are private-denylist only):
  //    a private address in a subject is refused with no denylist entry for it.
  const genericList = path.join(dir, "generic-only");
  writeFileSync(genericList, "# no entries\n", "utf8");
  process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = genericList;
  resetDenylistCacheForTests();
  // The entry-bearing list is restored for the sanity checks at the end, which
  // ask the checker about TERM itself.
  const entryList = list;
  const addr = recording();
  let addrThrown: unknown;
  let addrResult: unknown;
  try {
    addrResult = await executeAndVerifyMerge(
      7,
      "squash",
      addr.exec,
      repoRoot,
      "fix: point at 10.1.2.3",
      NO_FORGE,
    );
  } catch (err) {
    addrThrown = err;
  }
  assert(
    addrThrown === undefined && (addrResult as { ok?: boolean })?.ok === false,
    "the generic set also refuses a private address in a merge subject, as a result",
  );
  assert(
    addr.calls.every((c) => !c.includes("pr merge")),
    "and that refusal too happens before any exec",
  );
  process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = entryList;
  resetDenylistCacheForTests();
  // Sanity: the seam's own checker answers, so a failure above means the merge
  // path is missing the check and not that the checker is unreachable. It is
  // called with the default reader, so it is asked while the denylist is the
  // entry-bearing one rather than the generic-only file case 4 installs.
  resetDenylistCacheForTests();
  assert(
    publicTextRefusal("merge commit subject", `ship ${TERM}`) !== undefined,
    "the forge seam's own checker refuses the same subject",
  );
  assert(
    publicTextRefusal("merge commit subject", "feat(x): clean") === undefined,
    "and passes a clean one",
  );
} finally {
  if (prev === undefined) delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  else process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = prev;
  if (prevForge === undefined) delete process.env.PI_ENSEMBLE_FORGE;
  else process.env.PI_ENSEMBLE_FORGE = prevForge;
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
