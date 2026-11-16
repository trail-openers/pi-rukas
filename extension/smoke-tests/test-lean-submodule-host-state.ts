#!/usr/bin/env bun
/**
 * lean — the seeding leaves the SUPERPROJECT's own records alone (#2319, the shared-config half).
 *
 * Split out of `test-lean-submodule-local-source.ts` when that file passed the size gate. Same
 * fixtures, same offline exec, same case (a) — the seam is the question being asked. That file
 * asks WHERE the bytes came from; this one asks what the run LEFT BEHIND in the repository it was
 * handed, which is the property the adversarial finding was about.
 *
 * The defect this exists for: pointing an entry at a local source looks like a config write, and
 * `git submodule set-url` IS one. Run from a linked worktree it writes `submodule.<name>.url`
 * into `<superproject>/.git/config` — not the worktree-local file — so it lands in the SHARED
 * config that every later git in the operator's own checkout consults: `submodule status`, a
 * `submodule update` they run themselves, a `fetch --recurse-submodules`. The only compensating
 * restore in the reset was `checkout … -- .gitmodules`, which repairs the work-tree file and
 * never that key, so the write was invisible to `git status` in the tree the operator works in.
 * The pass now names its source as `-c` on the one invocation that reads it, which cannot outlive
 * the process.
 *
 * (a) is the operator's case, run once over one fixture, and it makes BOTH claims at once: the
 * seeding worked (the tree holds the submodule at the recorded gitlink), and nothing in the
 * superproject was rewritten. Reading the shared config with `--file` naming it asks git about
 * that one file rather than about git's merge of all of them.
 */

import path from "node:path";
import { ensureSpecifyWorktreeWithProvision } from "../src/lean/specify-tree.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  offlineExec,
  populated,
  readOrNull,
  submoduleHead as submoduleHeadAt,
} from "./lib/lean-submodule-fixture-net.ts";
import {
  SUB,
  UNREACHABLE_URL,
  gitIn,
  gitlinkSha,
  repoWithSubmodule,
} from "./lib/lean-submodule-local-fixture.ts";

const { assert, failures } = makeAssert();

/** The submodule's own HEAD as git reports it, or `undefined` when it has none. */
const headIn = (dir: string, rel?: string): string | undefined => submoduleHeadAt(dir, rel);

/** The argv of the call that names where the bytes come from. */
function sourceArgv(calls: readonly { cmd: string; argv: readonly string[] }[]) {
  return calls.find(
    (c) =>
      c.cmd === "git" &&
      c.argv.includes("submodule") &&
      c.argv.some((a) => a.startsWith(`submodule.${SUB}.url=`)),
  )?.argv;
}

/** Every argv of the step's that carries `a`. */
const carrying = (
  calls: readonly { cmd: string; argv: readonly string[] }[],
  a: string,
): readonly (readonly string[])[] => calls.filter((c) => c.argv.includes(a)).map((c) => c.argv);

// ── (a) the operator's case, and the host-state claims that go with it
{
  const { repoRoot, baseSha, remote } = repoWithSubmodule("hoststate");
  const recorded = gitlinkSha(repoRoot, SUB);
  const { exec, calls, network } = offlineExec();
  let threw: Error | undefined;
  let wt = "";
  try {
    wt = (
      await ensureSpecifyWorktreeWithProvision(exec, {
        repoRoot,
        issue: 1,
        fromRef: baseSha,
        branch: "lean/issue-1",
      })
    ).wt;
  } catch (err) {
    threw = err as Error;
  }
  assert(threw === undefined, `(a) preparation succeeded (${threw?.message?.slice(0, 200)})`);
  assert(
    network.length === 0,
    `(a) no network-shaped git call was issued (got ${JSON.stringify(network)})`,
  );
  // The precondition for every claim below: had the seeding not run, "nothing was rewritten"
  // would be true of a step that did nothing, which is the shape this file must never accept.
  assert(
    populated(wt) && headIn(wt) === recorded && recorded !== undefined,
    `(a) the seeding really ran: the submodule holds its file at the recorded gitlink (got ${
      populated(wt) ? "there" : "empty"
    }, HEAD ${String(headIn(wt))}, want ${String(recorded)})`,
  );
  // The SUPERPROJECT's own records, three of them, each asked of the file itself rather than
  // inferred from the run's account of what it did:
  //
  //   - `.gitmodules` — the file a `set-url` rewrites in the work tree;
  //   - `.git/config` — the SHARED config the same command writes from a linked worktree, and
  //     the one this file exists for; asked with `--file` naming it, so the read is of that file
  //     and not of git's merge;
  //   - the module store's own config — the seeding's SOURCE, where a write is invisible to the
  //     question actually being asked.
  //
  // The value the shared config is compared against is the fixture's own `remote`, because a
  // fixture that mounted the submodule with `git submodule add` never rewrote it — `add` wrote
  // the local mount there, and the sabotage that makes this case mean something rewrites
  // `.gitmodules` only. So the honest question is not "does it still say the unreachable URL"
  // (it never did) but "does it still say what the operator put there, and not a path THIS step
  // chose" — which is exactly the regression: after a `set-url`, git answers a harness-computed
  // `.git/modules/…` path the operator never wrote.
  const shared = gitIn(
    repoRoot,
    "config",
    "--file",
    ".git/config",
    "--get",
    `submodule.${SUB}.url`,
  );
  const superRecorded = gitIn(
    repoRoot,
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `submodule.${SUB}.url`,
  );
  const storeConfig =
    readOrNull(path.join(repoRoot, ".git", "modules", ...SUB.split("/"), "config")) ?? "";
  const localSeed = `${path.sep}.git${path.sep}modules${path.sep}`;
  assert(
    superRecorded === UNREACHABLE_URL,
    `(a) .gitmodules still records the base's own URL (got ${superRecorded}, want ${UNREACHABLE_URL})`,
  );
  assert(
    shared === remote && !shared.includes(localSeed),
    `(a) the SHARED .git/config still names the mount the operator chose, not one this step computed (got ${shared}, want ${remote})`,
  );
  assert(
    !storeConfig.includes(localSeed),
    `(a) and the module store's own config holds no local seed the step wrote`,
  );
  // No durable write of any kind: nothing on the local arm ever retargets an entry in config,
  // so there is nothing for the reset's `.gitmodules` restore to be papering over.
  const rewrites = calls.filter((c) => c.argv.includes("set-url")).map((c) => c.argv);
  assert(
    rewrites.length === 0,
    `(a) and no command of the step's rewrites a submodule URL in config (got ${JSON.stringify(
      rewrites,
    )})`,
  );
  // The source is named, and named as a `-c` on the call that reads it — the positive form of
  // the same rule, so a step that populated from some other source entirely cannot satisfy both
  // this and the HEAD check above.
  const seeding = sourceArgv(calls);
  assert(
    seeding?.some((a) => a.startsWith(`submodule.${SUB}.url=${repoRoot}${path.sep}`)) === true,
    `(a) and the source was named as a -c that is a path inside the superproject (got ${String(
      seeding,
    )})`,
  );
  assert(
    carrying(calls, "protocol.file.allow=always").length === 1,
    `(a) and the transport licence still rides on exactly one call (got ${JSON.stringify(
      carrying(calls, "protocol.file.allow=always"),
    )})`,
  );
}

process.exit(failures() === 0 ? 0 : 1);
