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

import { existsSync } from "node:fs";
import path from "node:path";
import { submoduleState as submoduleStateAt } from "../src/lean/specify-submodules.ts";
import { ensureSpecifyWorktreeWithProvision } from "../src/lean/specify-tree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  offlineExec,
  populated,
  readOrNull,
  submoduleHead as submoduleHeadAt,
} from "./lib/lean-submodule-fixture-net.ts";
import {
  INSIDE,
  NESTED,
  NESTED_INSIDE,
  SUB,
  UNREACHABLE_URL,
  gitIn,
  gitlinkSha,
  repoWithAbsentSubmodule,
  repoWithNestedSubmodule,
  repoWithSubmodule,
} from "./lib/lean-submodule-local-fixture.ts";
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
/**
 * The local arm's two calls, transcribed from the implementation the same way — a
 * control that reads the current code agrees with itself, so each is pinned as a
 * literal and compared against the argv the step actually issued.
 *
 * The source and the `file` licence are BOTH command-line `-c` on the one call that consumes
 * them, and that is what bounds the pair: neither can outlive the invocation, so neither is ever
 * written into the superproject's shared `.git/config` (a `git submodule set-url` would have put
 * the harness-chosen path there, where every later git in the operator's checkout reads it and
 * nothing in this harness ever restores it). No `-c` appears on any other invocation, and no
 * `--recursive` appears anywhere on the local arm, so the nested level is never seeded. That is
 * the depth rule rather than an oversight, and it is also what bounds the licence: git consults
 * the transport policy only where it performs a fetch, and every fetch this arm performs has a
 * source this module named on its own argv.
 */
const LOCAL_INIT_ARGV = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "submodule",
  "init",
  "--",
  SUB,
];
/** The `-c` argument that names the source, for a seeding that read it from `source`. */
const sourceOverride = (source: string): string => `submodule.${SUB}.url=${source}`;
/** The one call the `file` licence and the source override ride on. */
const LOCAL_UPDATE_ARGV = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  // Keyed by the submodule's NAME, spelled as git spells it — one `submodule.` prefix. A name
  // that still carried the prefix would build `submodule.submodule.…`, a key git never consults,
  // and the seeding would fall back to the base's recorded URL while every case below stayed green.
  `submodule.${SUB}.url=<source>`,
  "-c",
  "protocol.file.allow=always",
  "submodule",
  "update",
  "--",
  SUB,
];

/**
 * The step's populating call for the seeding of `source`, in the shape the reset issues it.
 *
 * Pinned as a literal rather than read back from the code: a control that imported the
 * implementation's own argv builder would agree with it by construction and separate nothing.
 */
const expectedUpdate = (source: string): string[] =>
  LOCAL_UPDATE_ARGV.map((a) =>
    a === `submodule.${SUB}.url=<source>` ? `submodule.${SUB}.url=${source}` : a,
  );
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

/** The argv of the call that names where the bytes come from, on either arm. */
function sourceArgv(calls: Calls): readonly string[] | undefined {
  return calls.find(
    (c) =>
      c.cmd === "git" &&
      c.argv.includes("submodule") &&
      c.argv.some((a) => a.startsWith(`submodule.${SUB}.url=`)),
  )?.argv;
}

/** Two argv equal element for element. */
function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Every argv of the step's that carries `a`. */
const carrying = (calls: Calls, a: string): readonly (readonly string[])[] =>
  calls.filter((c) => c.argv.includes(a)).map((c) => c.argv);

/** Every argv of the step's whose text contains `a`. */
const carryingText = (calls: Calls, a: string): readonly (readonly string[])[] =>
  calls.filter((c) => c.argv.some((w) => w.includes(a))).map((c) => c.argv);

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
  // The two calls, each pinned as a literal: the rule under test read off the argv
  // rather than inferred from the green. The computed path is a `-c` value on the one
  // call that consumes it — never a `set-url` operand, which is what wrote the
  // harness-chosen path into the shared config (see `specify-submodules.ts`) — and never a
  // value taken from `.gitmodules`, whose URL the step does not use as a source.
  const seeding = sourceArgv(calls);
  assert(
    seeding?.some((a) => a === sourceOverride(`${repoRoot}${path.sep}${SUB}`)) === true ||
      seeding?.some((a) => a.startsWith(`submodule.${SUB}.url=${repoRoot}${path.sep}`)) === true,
    `(a) the submodule's source was named as an argument and was a path inside the superproject (got ${String(
      seeding,
    )})`,
  );
  assert(
    carrying(calls, "submodule").some((a) => sameArgv(a, LOCAL_INIT_ARGV)),
    `(a) and the entry was registered by git's own init, per path (got ${JSON.stringify(
      carrying(calls, "submodule"),
    )})`,
  );
  const seededSource = seeding
    ?.find((a) => a.startsWith(`submodule.${SUB}.url=`))
    ?.slice(`submodule.${SUB}.url=`.length);
  assert(
    seededSource !== undefined &&
      carrying(calls, "submodule").some((a) => sameArgv(a, expectedUpdate(seededSource))),
    `(a) and the populating call is the pinned per-path update, with the source as a -c on that same call (got ${JSON.stringify(
      carrying(calls, "submodule"),
    )})`,
  );
  // Exactly one call carries the licence and it is the populating one; the reads need none,
  // so the licence is confined to the single invocation that moves bytes.
  const licensed = carrying(calls, "protocol.file.allow=always");
  assert(
    licensed.length === 1 &&
      licensed[0]?.includes("submodule") === true &&
      licensed[0]?.includes("update") === true &&
      licensed[0]?.includes("--recursive") === false,
    `(a) the transport licence rides on exactly one call, the per-path update (got ${JSON.stringify(
      carrying(calls, "protocol.file.allow=always"),
    )})`,
  );
  assert(
    carryingText(calls, UNREACHABLE_URL).every((a) => a.includes("config")),
    `(a) the recorded URL was read back to git and never carried to a fetch (got ${JSON.stringify(
      carryingText(calls, UNREACHABLE_URL),
    )})`,
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
  const seeded = sourceArgv(calls);
  assert(
    seeded?.some(
      (a) =>
        a.startsWith(`submodule.${SUB}.url=`) &&
        a.includes(`${path.sep}.git${path.sep}modules${path.sep}`),
    ) === true,
    `(b) the source was the module store under .git/modules, named as the -c the populating call reads (got ${String(
      seeded,
    )})`,
  );
  const carried = calls.filter((c) => c.argv.some((a) => a.includes(UNREACHABLE_URL)));
  assert(
    carried.every((c) => c.argv.includes("config")),
    `(b) no fetch-shaped git call of the step's carried the recorded URL (got ${JSON.stringify(
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
    problem?.includes(SUB) === true,
    `(c) the disclosure names the submodule path (got ${String(problem)})`,
  );
  assert(
    problem !== undefined &&
      /absent from the superproject|nothing on this host could supply/.test(problem),
    `(c) and says why: nothing here could supply it (got ${String(problem)})`,
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
  // The nested level is the depth rule made visible. The seeding is per-path and
  // NON-recursive, so a deeper submodule is never seeded: the outer one is populated,
  // the nested one is left exactly as an unseeded gitlink — an empty directory, at no
  // commit of its own — and named in the disclosure. The fixture deleted the inner
  // source and emptied the outer repo's nested checkout, so there is no reading of this
  // green in which the nested level appeared by some other route.
  assert(
    populated(wt, NESTED_INSIDE) === false,
    `(d) and the nested level was NOT seeded — depth stops at one (got ${
      populated(wt, NESTED_INSIDE) ? "populated" : "absent"
    })`,
  );
  assert(
    headIn(wt) === recorded && recorded !== undefined,
    `(d) the outer one at its gitlink (got ${String(headIn(wt))}, want ${String(recorded)})`,
  );
  // git's own answer, read inside the seeded submodule and answered per path rather
  // than by a status glyph whose spelling this suite would then have to be right about:
  // the nested level's git dir must not exist and its checkout must hold nothing. That
  // is what "used only if already present, otherwise absent" means in bytes, and it is
  // the state a seeded nested level would destroy — a seeded one has a git dir.
  const nested = path.join(wt, SUB, NESTED);
  const nestedGitDir = path.join(wt, SUB, ".git", "modules", ...NESTED.split("/"));
  assert(
    !existsSync(path.join(nested, "lib")) && !existsSync(path.join(nestedGitDir, "objects")),
    `(d) and the nested level holds nothing: no checkout content and no git dir (dir=${existsSync(
      nested,
    )}, gitdir=${existsSync(path.join(nestedGitDir, "objects"))})`,
  );
  const nestedState = await submoduleStateAt(exec, path.join(wt, SUB));
  assert(
    nestedState === undefined || nestedState.registered.length === 0,
    `(d) and git's own submodule read of the seeded level lists nothing seeded (got ${JSON.stringify(
      nestedState,
    )})`,
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
    off?.message.includes("git submodule update --init --recursive") === true,
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
