#!/usr/bin/env bun
/**
 * lean — a worktree's submodules come from the superproject, never from the
 * network (the offline-benchmark bug).
 *
 * The field failure: `could not prepare the worktree <trial>/repo/.worktrees/lean-1:
 * the worktree's submodules could not be initialised: git submodule update --init
 * --recursive — Submodule 'vendor/infogami' (https://github.com/…) registered for
 * path 'vendor/infogami' … Cloning into '…/vendor/infogami'`. The superproject's
 * checkout ALREADY held that submodule and the trial had no network by design, so
 * the step asked git for the one thing the host could not give it while the answer
 * sat on disk. The run handed back at exit 10 with nothing frozen.
 *
 * The rule this pins: for each registered submodule, initialise from the
 * superproject — its module store under `.git/modules/<name>` when it has one, else
 * its populated checkout — through a per-invocation URL override, so `.gitmodules`
 * and the superproject's config are never rewritten. A submodule the superproject
 * never had is NOT fetched: preparation proceeds and the path is named in a
 * disclosure.
 *
 * Every case drives `ensureSpecifyWorktreeWithProvision` — the function lean's
 * worktree preparation IS — over real temp repos, with the exec under test refusing
 * any network-shaped argv before the child spawns. So "no network was attempted" is
 * read off the argv git was asked to run, not off a host's connectivity.
 *
 *   (a) the operator's case: a populated checkout, an unreachable recorded URL →
 *       preparation succeeds, the submodule's HEAD is the recorded gitlink, and
 *       nothing outside the worktree was rewritten;
 *   (b) the objects live only under `.git/modules` → the same, and the argv names
 *       the module store as the source, with no call anywhere carrying the URL;
 *   (c) the submodule is absent from the superproject → preparation proceeds and the
 *       disclosure names the path;
 *   (d) a nested submodule is populated too, at its own recorded gitlink;
 *   (e) `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0` reproduces origin/main's failure and
 *       origin/main's message, with origin/main's argv.
 */

import path from "node:path";
import { ensureSpecifyWorktreeWithProvision } from "../src/lean/specify-tree.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  INSIDE,
  NESTED_INSIDE,
  SUB,
  UNREACHABLE_URL,
  gitIn,
  gitlinkSha,
  offlineExec,
  populated,
  readOrNull,
  repoWithAbsentSubmodule,
  repoWithNestedSubmodule,
  repoWithSubmodule,
  submoduleHead as submoduleHeadAt,
} from "./lib/lean-submodule-local-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** origin/main's submodule call, transcribed — the off arm must match it exactly. */
const MAIN_SUBMODULE_ARGV = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "submodule",
  "update",
  "--init",
  "--recursive",
];
/** The opening of origin/main's handback for a submodule it could not populate. */
const MAIN_HANDBACK = "the worktree's submodules could not be initialised in";

type Calls = readonly { cmd: string; argv: readonly string[] }[];

/** The submodule's own HEAD as git reports it, or `undefined` when it has none. */
const headIn = (dir: string, rel?: string): string | undefined => submoduleHeadAt(dir, rel);

/** The argv of the call that populates submodules, or `undefined` when none ran. */
function updateArgv(calls: Calls): readonly string[] | undefined {
  return calls.find(
    (c) => c.cmd === "git" && c.argv.includes("submodule") && c.argv.includes("update"),
  )?.argv;
}

// ── (a) the operator's case: a populated checkout and an unreachable recorded URL
{
  const { repoRoot, baseSha } = repoWithSubmodule("a");
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
  assert(
    populated(wt),
    `(a) the worktree's submodule holds its committed file (got ${
      populated(wt) ? "there" : "empty"
    })`,
  );
  assert(
    headIn(wt) === recorded && recorded !== undefined,
    `(a) its HEAD is the gitlink the base records (got ${String(headIn(wt))}, want ${String(
      recorded,
    )})`,
  );
  assert(
    readOrNull(path.join(repoRoot, ".gitmodules"))?.includes(UNREACHABLE_URL) === true,
    "(a) .gitmodules still records the base's own URL — nothing was rewritten",
  );
  // The superproject's own config must still name the base's URL. `submodule.<name>.url`
  // in the superproject's LOCAL config is git's own override of `.gitmodules`, so a
  // run whose preparation wrote it there would fix the next run by accident and hide
  // a step that mutated the repository it was handed: the assertion asks git what the
  // file really holds, with the case's own per-invocation override supplying the value
  // `.gitmodules` records (that is the value a clean check of "rewritten?" compares).
  const superUrl = gitIn(
    repoRoot,
    "-c",
    `submodule.${SUB}.url=${UNREACHABLE_URL}`,
    "config",
    "--local",
    "--get",
    `submodule.${SUB}.url`,
  );
  assert(
    superUrl === UNREACHABLE_URL,
    `(a) the superproject's config still names the base's URL (got ${superUrl})`,
  );
  // The source git was pointed at must be a path inside the superproject: the rule
  // under test, read off the argv rather than inferred from the green.
  const override = (updateArgv(calls) ?? []).find((a) => a.startsWith(`submodule.${SUB}.url=`));
  assert(
    override !== undefined && override.startsWith(`submodule.${SUB}.url=${repoRoot}/`),
    `(a) the submodule's source was a path inside the superproject (got ${String(override)})`,
  );
  const clean = gitIn(wt, "status", "--porcelain", "-uall");
  assert(clean === "", `(a) with the tree clean, submodule included (got ${clean})`);
  void INSIDE;
}

// ── (b) the objects live only under .git/modules
{
  const { repoRoot, baseSha } = repoWithSubmodule("b", { populate: "modules" });
  const recorded = gitlinkSha(repoRoot, SUB);
  const { exec, calls, network } = offlineExec();
  let threw: Error | undefined;
  let wt = "";
  try {
    wt = (
      await ensureSpecifyWorktreeWithProvision(exec, {
        repoRoot,
        issue: 2,
        fromRef: baseSha,
        branch: "lean/issue-2",
      })
    ).wt;
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(b) preparation used the module store (${threw?.message?.slice(0, 200)})`,
  );
  assert(
    network.length === 0,
    `(b) no network-shaped git call was issued (got ${JSON.stringify(network)})`,
  );
  assert(
    populated(wt),
    `(b) the submodule is populated (got ${populated(wt) ? "there" : "empty"})`,
  );
  assert(
    headIn(wt) === recorded && recorded !== undefined,
    `(b) at the recorded gitlink (got ${String(headIn(wt))}, want ${String(recorded)})`,
  );
  const override = (updateArgv(calls) ?? []).find((a) => a.startsWith(`submodule.${SUB}.url=`));
  assert(
    override !== undefined &&
      override.includes(`${path.sep}.git${path.sep}modules${path.sep}`),
    `(b) the source was the module store under .git/modules (got ${String(override)})`,
  );
  const carried = calls.filter((c) => c.argv.some((a) => a.includes(UNREACHABLE_URL)));
  assert(
    carried.length === 0,
    `(b) no git call of the step's carried the recorded URL (got ${JSON.stringify(
      carried.map((c) => c.argv),
    )})`,
  );
}

// ── (c) a submodule the superproject never had proceeds, and is named
{
  const { repoRoot, baseSha } = repoWithAbsentSubmodule("c");
  const { exec, network } = offlineExec();
  let threw: Error | undefined;
  let problem: string | undefined;
  let wt = "";
  try {
    const prepared = await ensureSpecifyWorktreeWithProvision(exec, {
      repoRoot,
      issue: 3,
      fromRef: baseSha,
      branch: "lean/issue-3",
    });
    problem = prepared.problem;
    wt = prepared.wt;
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(c) preparation proceeded without the submodule (${threw?.message?.slice(0, 200)})`,
  );
  assert(
    network.length === 0,
    `(c) and it did not reach for the network to get it (got ${JSON.stringify(network)})`,
  );
  assert(
    problem !== undefined && problem.includes(SUB),
    `(c) the disclosure names the submodule path (got ${String(problem)})`,
  );
  assert(
    problem !== undefined && /absent from the superproject/.test(problem),
    `(c) and says why: absent from the superproject (got ${String(problem)})`,
  );
  assert(
    wt !== "" && gitIn(wt, "status", "--porcelain", "-uall") === "",
    `(c) and the tree it left is clean (got ${wt === "" ? "no tree" : gitIn(wt, "status", "--porcelain", "-uall")})`,
  );
}

// ── (d) the nested level comes from the superproject too
{
    const { repoRoot, baseSha, submoduleHead, nestedHead } = repoWithNestedSubmodule("d");
  const recorded = submoduleHead;
  const nestedRecorded = nestedHead;
  const { exec, network } = offlineExec();
  let threw: Error | undefined;
  let wt = "";
  try {
    wt = (
      await ensureSpecifyWorktreeWithProvision(exec, {
        repoRoot,
        issue: 4,
        fromRef: baseSha,
        branch: "lean/issue-4",
      })
    ).wt;
  } catch (err) {
    threw = err as Error;
  }
  assert(threw === undefined, `(d) the nested case prepared (${threw?.message?.slice(0, 240)})`);
  assert(network.length === 0, `(d) with no network-shaped call (got ${JSON.stringify(network)})`);
  assert(
    populated(wt),
    `(d) the outer submodule is populated (got ${populated(wt) ? "there" : "empty"})`,
  );
  assert(
    populated(wt, NESTED_INSIDE),
    `(d) and so is the nested one (got ${populated(wt, NESTED_INSIDE) ? "there" : "empty"})`,
  );
  assert(
    headIn(wt) === recorded && recorded !== undefined,
    `(d) the outer one at its gitlink (got ${String(headIn(wt))}, want ${String(recorded)})`,
  );
  assert(
    headIn(wt, "vendor/lib/nested/deep") === nestedRecorded &&
      nestedRecorded !== undefined,
    `(d) and the nested one at its own gitlink (got ${String(
      headIn(wt, "vendor/lib/nested/deep"),
    )}, want ${String(nestedRecorded)})`,
  );
}

// ── (e) `=0` is origin/main's behaviour: same argv, same failure, same message
{
  const { repoRoot, baseSha } = repoWithSubmodule("e");
  const { exec, calls, network } = offlineExec();
  const submoduleArgvs = () => calls.filter((c) => c.cmd === "git" && c.argv.includes("submodule"));
  let off: { kind: "threw" | "ok"; message: string } | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL: "0" }, async () => {
    try {
      await ensureSpecifyWorktreeWithProvision(exec, {
        repoRoot,
        issue: 5,
        fromRef: baseSha,
        branch: "lean/issue-5",
      });
      off = { kind: "ok", message: "" };
    } catch (err) {
      off = { kind: "threw", message: (err as Error).message };
    }
  });
  assert(
    off?.kind === "threw" && off.message.includes(MAIN_HANDBACK),
    `(e) with the switch at 0 the run hands back as origin/main does (got ${
      off?.kind
    }: ${off?.message.slice(0, 200)})`,
  );
  assert(
    off !== undefined && off.message.includes("git submodule update --init --recursive"),
    `(e) the message names the command it ran (got ${off?.message.slice(0, 200)})`,
  );
  const argv = updateArgv(calls);
  assert(
    JSON.stringify(argv) === JSON.stringify(MAIN_SUBMODULE_ARGV),
    `(e) and the submodule call is origin/main's argv byte for byte (got ${JSON.stringify(argv)})`,
  );
  // The off arm asked git to populate the gitlink in git's own transport policy: no
  // local source override anywhere in the argv it issued. With the switch ON the same
  // repo shape is green without a single network-shaped call (cases a–d), which is
  // what makes this arm the control rather than the same run twice.
  const asked = submoduleArgvs();
  assert(
    asked.length > 0 && asked.every((c) => c.argv.every((a) => !a.startsWith("submodule."))),
    `(e) the off arm gave git no local source to clone from (got ${JSON.stringify(
      asked.map((c) => c.argv),
    )})`,
  );
  assert(
    readOrNull(path.join(repoRoot, ".gitmodules"))?.includes(UNREACHABLE_URL) === true,
    "(e) and the off arm left .gitmodules alone, as it always did",
  );
}

process.exit(failures() === 0 ? 0 : 1);
