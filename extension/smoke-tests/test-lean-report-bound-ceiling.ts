#!/usr/bin/env bun
/**
 * lean: the routed deadline report is bounded by the handoff allowance (#2269).
 *
 * A deadline stop routes the run into `handback` because the report is the one step
 * `deadlineStopsSteps` exempts (#2268). That exemption is also what left the report
 * with no wall: it is not started through `startStep`/`settle`, so it gets neither
 * the step's own budget nor the cycle clamp, and the only bounds on it were the
 * per-call git and forge timeouts inside the handler. A hung await inside the
 * reporting step — a wedged in-process call, a comment poster that never returns —
 * therefore held the run past the allowance it exists to protect, and a wrapper's
 * kill recorded a kill instead of the handback. The bound is
 * `handoffAllowanceMs()` — the allowance the routing spends — raced against the
 * handler, and on overrun the run takes the plain deadline stamp.
 *
 *   (a) a hung handler is cut at the bound: the run ends `handed-back` with the
 *       plain deadline stamp, names the bound that fired in BOTH its reason and a
 *       `traceWarn`, writes no report entry, and the handler's late settle writes
 *       nothing. The bound is asserted against the shared helper, not a copy of the
 *       number; origin is untouched, because the cut handler hung before any push;
 *       and the per-issue lock is free behind it, which is the executed evidence
 *       that `runLean`'s `finally` released it;
 *   (b) the bound's ARITHMETIC is the helper's own answer: one arm of a fixed
 *       allowance is settled inside the bound and still delivered its verdict —
 *       proof the bound was large enough to let a real report land, so (a)'s cut
 *       cannot be a bound of zero — while the hung arm of the same allowance is
 *       cut at that number within the case's own guard, a guard that fails the case
 *       rather than hanging the suite;
 *   (d) the bound's timer is a ref'd timer and is cleared on the way out of the race
 *       — read off the source, because both properties are invisible to a drive from
 *       outside (a passing drive exits either way). Ref'd is the direction the timer
 *       has to go: an unref'd bound timer is not a reason the loop stays alive, so a
 *       hung handler that holds no handle of its own lets the process exit with the
 *       run carrying no result at all. The `clearTimeout` in the race's `finally` is
 *       what keeps the ref'd timer from outliving the run, so the pair is asserted
 *       together;
 *   (e) the overrun's reason is honest about what the bound does NOT cancel: the
 *       rewind's push and the forge comment of a cut report are already in flight and
 *       may still land after the stamp, so the sentence says so — and the settled arm,
 *       which abandoned nothing, says neither word;
 *   (f) the bound is wide enough for the awaits inside the real reporting step, AND still
 *       fires inside the grace that would otherwise kill the run instead. Both numbers come
 *       from the constants the shipped code reads — the bound from `handoffReportBoundMs()`,
 *       the outer limit from `childBoundGraceMs()` — and the sum of every per-call ceiling on
 *       the path must fit inside the bound. The bound is `handoffAllowanceMs()` **plus**
 *       headroom, because the path's own ceilings sum to more than the allowance: a bound
 *       equal to the allowance cuts a report that was answering every one of its calls, and
 *       the thing that cut loses is the rewind the routing exists to perform. The second arm
 *       runs the other way: the bound may not outlast the grace, because then no report ever
 *       times out and every cut one is a wrapper's kill.
 *
 * The rig is the same one the two deadline suites drive (`driveToDeadline`): the
 * crossing clock, the scripted walk, and the production reporting wiring. Every case
 * owns its repo, and each drive races a guard of its own — an unref'd timer, so a
 * regression on the unbounded arm is a failed case rather than a suite that never
 * exits (R3). `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` is pinned per case rather than
 * inherited from the rig's `ENV`, which is what lets the bound be read as an
 * `allowance` the case knows and pins.
 */

import {
  GUARD_MS,
  assert,
  greenAt,
  guarded,
  hungHandler,
  recordBytes,
  rigEnv,
  state,
} from "./lib/lean-report-bound-shared.ts";
import { childBoundGraceMs } from "../src/spawn-child-bound.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { handoffReportBoundMs } from "../src/lean/engine-report.ts";
import { withEnv } from "./lib/env-scope.ts";
import { captureWarns } from "./lib/lean-review-bound-fixtures.ts";
import { driveToDeadline } from "./lib/lean-verified-handback-deadline-rig.ts";
import { ISSUE } from "./lib/lean-verified-handback-fixture.ts";
import { repoWithFixHead } from "./lib/lean-verified-handback-repo.ts";
import type { Driven } from "./lib/lean-report-bound-shared.ts";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";

// ── (f) the bound is wide enough for the awaits INSIDE the real reporting step.
//
// The bound is `handoffAllowanceMs()`, and the routed report is the one step the stop
// test exempts — so the bound and the allowance the run stopped inside are the same
// number. That is only safe while the reporting step's own awaits finish inside it. The
// step is the production one (`reportHandlers` → `handbackOutcome`), so the awaits are
// the rewind's git calls, the origin reads, the forge detection, the visibility lookup
// and the comment post. Each carries its own per-call ceiling; none of them is armed by
// this engine and none is adjustable per call. Summed, they are the worst case a
// slow-but-progressing report can spend before the bound cuts it, and the cut is what
// loses the rewind — the exact thing the routing exists to perform.
//
// The numbers are READ, not typed: each entry names the export or the source line that
// carries it, so raising one ceiling turns this case red by itself rather than leaving a
// hand-copied total behind.
{
  // Read where the numbers live rather than importing them: the ceiling of a call is a
  // literal on its own call site as often as it is an exported constant, and a gate that
  // imports only the exported ones is a gate that misses the literals.
  const readSource = (file: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", "src", file), "utf8");

  /** Read one numeric constant out of the source that declares it, exported or not, so the
   *  sum is the sum of what the shipped calls carry rather than of hand-copied numbers. */
  const exportedMs = (file: string, name: string): number => {
    const src = readSource(file);
    const found = src.match(new RegExp(`(?:export )?const ${name} = (\\d[\\d_]*)`));
    assert(found !== undefined, `(f) ${file} still declares ${name} as a numeric literal`);
    return Number((found?.[1] ?? "0").replace(/_/g, ""));
  };
  const forgeExecTimeout = () => exportedMs("forge-detect.ts", "FORGE_EXEC_TIMEOUT_MS");
  const mainlineProbeTimeout = () => exportedMs("mainline.ts", "MAINLINE_PROBE_TIMEOUT_MS");
  const visibilityTimeout = () =>
    exportedMs("public-hygiene-visibility.ts", "VISIBILITY_TIMEOUT_MS");
  const netGitTimeout = () => exportedMs("work-driver-net-git.ts", "NET_GIT_TIMEOUT_DEFAULT_MS");

  /** One await on the routed report's path, with the ceiling that call actually carries. */
  interface ReportAwait {
    /** What is awaited, in the shape an operator would act on. */
    readonly what: string;
    /** Where the number lives — an export, or `file:line` for a call-site literal. */
    readonly where: string;
    readonly ms: number;
    /** Set on a row that documents a call no single run takes — an arm exclusive with another
     *  row — so the table still names it while the sum counts the path once. */
    readonly excluded?: boolean;
  }

  /** A call-site timeout literal, read back out of the source that carries it, searched
   *  from the `occurrence`-th copy of `needle` and bounded before `stop` so a search that
   *  walked past its own call and found the next one's timeout says so rather than print a
   *  confident wrong number. Fails the case when a line moves or its number changes: the
   *  sum has to be the sum of what the calls really carry. */
  const MINUTE = 60_000;
  const callTimeout = (
    file: string,
    needle: string,
    label: string,
    occurrence = 0,
    stop?: string,
    stopOccurrence = 0,
  ): number => {
    const src = readSource(file);
    let at = src.indexOf(needle);
    for (let n = 0; n < occurrence; n++) at = src.indexOf(needle, at + 1);
    assert(at >= 0, `(f) ${label}: ${file} still contains ${JSON.stringify(needle)}`);
    let stopAt = stop === undefined ? -1 : src.indexOf(stop, at);
    for (let n = 0; stop !== undefined && n < stopOccurrence; n++)
      stopAt = stopAt < 0 ? -1 : src.indexOf(stop, stopAt + 1);
    assert(
      stop === undefined || stopAt > at,
      `(f) ${label}: ${JSON.stringify(stop)} still follows ${JSON.stringify(needle)} in ${file}`,
    );
    const window = src.slice(at, stopAt < 0 ? at + 400 : stopAt);
    const found = window.match(
      /timeout(?:Ms)?:\s*(\d[\d_]*|MINUTE_MS|MAINLINE_PROBE_TIMEOUT_MS|DEFAULT_EXEC_TIMEOUT_MS|FORGE_EXEC_TIMEOUT_MS|VISIBILITY_TIMEOUT_MS|NET_GIT_TIMEOUT_DEFAULT_MS)/,
    );
    assert(
      found !== undefined,
      `(f) ${label}: a timeout is readable between ${JSON.stringify(needle)} and ${JSON.stringify(stop ?? "its next 400 characters")} in ${file}`,
    );
    const raw = found?.[1] ?? "0";
    if (/^\d/.test(raw)) return Number(raw.replace(/_/g, ""));
    const consts: Record<string, () => number> = {
      MINUTE_MS: () => MINUTE,
      MAINLINE_PROBE_TIMEOUT_MS: mainlineProbeTimeout,
      FORGE_EXEC_TIMEOUT_MS: forgeExecTimeout,
      VISIBILITY_TIMEOUT_MS: visibilityTimeout,
      NET_GIT_TIMEOUT_DEFAULT_MS: netGitTimeout,
      DEFAULT_EXEC_TIMEOUT_MS: () => exportedMs("forge.ts", "DEFAULT_EXEC_TIMEOUT_MS"),
    };
    const reader = consts[raw];
    assert(reader !== undefined, `(f) ${label}: timeout expression ${raw} is not a known constant`);
    return reader === undefined ? 0 : reader();
  };

  /** The ceiling an `ls-remote` origin read carries, read from the wrapped call inside the
   *  window its row names. `needle` is the call site the row bills and `stop` the boundary
   *  of that body, so the window holds exactly one `runNetGit` options object and the
   *  number can only be that read's ceiling — a search that walked past its own body would
   *  print the first wrapped read's number under every row while looking distinct, and a read
   *  whose ceiling was deleted would keep the sum looking right while the bound was proven
   *  against a shorter path than the one a run takes. The wrapper is what caps the call, so
   *  it is what the bound has to cover. A row that reads no ceiling fails rather
   *  than contributing 0, which would lower the sum without anyone noticing.
   *
   *  Every origin read now shares one helper, so a row whose needle is the helper's own
   *  declaration reports the helper's wrapped ceiling — correct for each read that reaches
   *  it, and named in its `where` by the call it bills. A row whose needle is a distinct
   *  call site (the excluded `originBranchHead` row) still has to find a wrapped call inside
   *  its own window: a site that no longer routes says so here rather than reading the
   *  number out of the helper two hundred lines below it. */
  const lsRemoteCeiling = (needle: string, label: string, stop = CALL_BOUNDARY): number => {
    const src = readSource("lean/handback-rewind.ts");
    const at = src.indexOf(needle);
    // `stop` is a function of where the needle landed, not of the source from the top: the
    // needle can sit PAST the first copy of the boundary (the file holds three `exec("git")`
    // calls, and the excluded `originBranchHead` row sits above all of them). Searching for
    // the boundary from 0 instead made that window end behind its own wrapped call, and the
    // row reported a ceiling it had not looked for.
    const boundary = src.indexOf(stop, at);
    // The wrapper is what caps the call, so it is what the bound has to cover: the
    // window from the row's needle to its boundary must CONTAIN a `runNetGit` call, and the
    // timeout read inside that window is the ceiling. The two halves are asserted apart
    // because each fails on a different edit — a wrapper call deleted, a window widened, a number
    // removed — and one combined failure would not say which happened.
    const routed = src.indexOf('runNetGit(exec, "git"', at);
    assert(
      at >= 0 && boundary > at,
      `(f) ${label}: ${JSON.stringify(needle)} is still a call whose window reaches ${JSON.stringify(stop)}`,
    );
    assert(
      routed > at && routed < boundary,
      `(f) ${label}: a runNetGit wrapped call still lies between ${JSON.stringify(needle)} and ${JSON.stringify(stop)} — without it this row has no ceiling to report`,
    );
    const found = src.slice(at, boundary).match(/timeout(?:Ms)?:\s*(\d[\d_]*)/);
    assert(
      found !== undefined,
      `(f) ${label}: a timeout is readable inside the window from ${JSON.stringify(needle)} to ${JSON.stringify(stop)} — a wrapped read that spells none is uncapped`,
    );
    const ms = Number((found?.[1] ?? "0").replace(/_/g, ""));
    assert(ms > 0, `(f) ${label}: read no ceiling from ${JSON.stringify(needle)}`);
    return ms;
  };

  /** The single origin-read helper, declared up to its wrapped call. Every origin read in the
   *  file is one call to it — the held head before the push, the refusal's re-read, both
   *  halves of the success check's pair, and `originBranchHead` — so each row below anchors
   *  on the CALL SITE it bills rather than on this body: rows anchored on one shared body
   *  would all print the same number while looking distinct, which is the failure this
   *  file's windowing exists to prevent. The helper's DECLARATION ends at the wrapped call,
   *  which is also where a row's window opens: the ceiling is read inside that call's own
   *  options object and nothing else. */
  const READ_HELPER =
    "async function originRead(exec: VerifyExec, cwd: string, ref: string): Promise<string | undefined> {\n" +
    '  const ran = await runNetGit(exec, "git", {';

  /** The helper's own body ends at its `return` of the parsed sha — the boundary for a row
   *  whose needle IS the helper, so its window holds that one options object and nothing
   *  further down the file. */
  const HELPER_RETURN = "return readSha(ran?.stdout)";

  /** Where a call site's window ends: the rewind push's own options object — the one call in
   *  the file OUTSIDE the wrapper, so it is also the far side of the helper's last read. A
   *  row whose needle lies in a caller closes there, so its ceiling can only come from the
   *  wrapped call on the near side. The helper's own rows close at the helper's `return`. */
  const CALL_BOUNDARY = "argv: pushArgv";

  const awaits: ReportAwait[] = [
    {
      what: "handback-rewind: assertPublishableBranch → resolveMainline (git symbolic-ref, then gh repo view, serially)",
      where: "mainline.ts MAINLINE_PROBE_TIMEOUT_MS × 2 probes",
      ms: mainlineProbeTimeout() * 2,
    },
    {
      what: "handback-rewind: assertPublishableBranch → origin probe (git ls-remote --symref origin HEAD)",
      where: "lean/publish-deps.ts originHeadBranch (runNetGit caps it at PI_ENSEMBLE_GIT_NET_TIMEOUT_MS)",
      ms: Math.min(mainlineProbeTimeout(), netGitTimeout()),
    },
    {
      what: "handback-rewind: origin read of the branch before the push",
      where: "lean/handback-rewind.ts originRead (held head, before the push)",
      ms: lsRemoteCeiling(READ_HELPER, "pre-push origin read", HELPER_RETURN),
    },
    {
      // The refusal's re-read is the fourth routed read, and it belongs in the table: an
      // operator reading a green suite should see that a failed push re-asks origin. It is
      // NOT summed, because it is the same call as the row above — one helper, one routed
      // body, reached again only when the push itself said no. Summing both would bill the
      // same read twice and fail (i) for a path no run walks.
      what: "handback-rewind: the refusal's re-read of the branch after a failed push (exclusive with the row above, not summed)",
      where: "lean/handback-rewind.ts originRead (refusal re-read)",
      ms: lsRemoteCeiling(READ_HELPER, "post-refusal origin read", HELPER_RETURN),
      excluded: true,
    },
    {
      what: "handback-rewind: does this clone hold the verified head (git cat-file -e)",
      where: "lean/handback-rewind.ts holdsCommit",
      ms: callTimeout("lean/handback-rewind.ts", 'argv: [...NO_HOOKS, "cat-file"', "rewind cat-file"),
    },
    {
      what: "handback-rewind: the rewind push (branch + keeping-ref, --atomic)",
      where: "lean/handback-rewind.ts push (runNetGit caps it at PI_ENSEMBLE_GIT_NET_TIMEOUT_MS)",
      ms: callTimeout("lean/handback-rewind.ts", 'argv: pushArgv', "rewind push"),
    },
    {
      what: "handback-rewind: the two origin reads that decide success (branch + keeping-ref, in parallel)",
      where: "lean/handback-rewind.ts originRead, Promise.all (branch + keeping-ref)",
      ms: lsRemoteCeiling(READ_HELPER, "post-push origin reads", HELPER_RETURN),
    },
    {
      // Named, not summed, and read through the helper it delegates to. `originBranchHead`
      // is NOT one of the rewind's awaits: it is made by the `handback` step on the other
      // side of the seam (`handback.ts`'s `readOrigin` default), and the path this table
      // bounds — `rewindFor` → `rewindToVerified` — never calls it; an earlier revision of
      // this file billed it to the rewind and failed (i) for a read no rewind makes. It
      // still belongs in the table because an operator reading a green run should see that
      // a handback asks origin where the branch stands, and should see the ceiling that
      // read carries rather than take it on faith. That ceiling is the routed arm of
      // `originRead`, which is what the row anchors on: `originBranchHead` spells no
      // `runNetGit` of its own any more, and a needle that jumped from the caller to the
      // helper would be a string no source line contains — a row that never matched is a
      // row reporting a number it never read. Its `where` names the call it bills, as the
      // three rewind rows do.
      what: "handback: originBranchHead — where the branch stands after the move (made by the handback step, outside the rewind's bounded path; not summed)",
      where: "lean/handback-rewind.ts originBranchHead",
      ms: lsRemoteCeiling(
        // One anchor, one window: this row bills the read the handback step makes, and the
        // only ceiling that read can carry is the routed arm of the helper it delegates to.
        // `originBranchHead` spells no `runNetGit` of its own any more, so the row anchors
        // on the helper and its `where` names the call it bills — which is exactly how the
        // three rewind rows work, and for the same reason: an anchor that jumped from the
        // caller to the helper would be a needle no source line contains, and a row that
        // never matched is a row that reports a number it never read.
        READ_HELPER,
        "originBranchHead",
        CALL_BOUNDARY,
      ),
      excluded: true,
    },
    {
      what: "postHandback → forgeFor: detectForge, up to three remote reads", 
      where: "forge-detect.ts FORGE_EXEC_TIMEOUT_MS × 3",
      ms: forgeExecTimeout() * 3,
    },
    {
      what: "postHandback → issueComment → public-hygiene: resolveCommandTarget (git remote get-url, then git remote)",
      where: "public-hygiene-target.ts askUrl + remoteList, each its own 10_000 literal",
      ms: callTimeout("public-hygiene-target.ts", '"remote", "get-url", name', "target remote get-url") + callTimeout("public-hygiene-target.ts", 'argv: ["remote"]', "remoteList"),
    },
    {
      what: "postHandback → issueComment → public-hygiene: the visibility lookup (gh api)",
      where: "public-hygiene-visibility.ts VISIBILITY_TIMEOUT_MS",
      ms: visibilityTimeout(),
    },
    {
      what: "postHandback → issueComment: the post itself (gh issue comment --body-file)",
      where: "forge.ts createForge run()'s DEFAULT_EXEC_TIMEOUT_MS",
      ms: callTimeout("forge.ts", "timeout: DEFAULT_EXEC_TIMEOUT_MS", "forge run() default"),
    },
  ];

  // Read where the numbers live rather than importing them: the ceiling of a call is a
  // literal on its own call site as often as it is an exported constant, and a gate that
  // imports only the exported ones is a gate that misses the literals.
  //
  // THE TABLE IS THE ARITHMETIC, NOT A COMMENT: it prints on both the pass and the fail
  // line, so a green suite still shows a reader what the bound has to cover and the two
  // numbers it is measured between. The bound is the allowance PLUS headroom precisely
  // because this sum is past the allowance: cutting a report whose every git and forge call
  // answered just inside its own ceiling would lose the rewind, the one thing the routing
  // exists to perform. Shrinking a shared ceiling instead would bind the non-lean callers
  // that read the same constants, so the headroom is the term that moved.
  const sum = awaits.reduce((total, a) => total + (a.excluded === true ? 0 : a.ms), 0);
  /** What the path would spend if the one `Promise.all` on it were serialised: the pair of
   *  origin reads that decide the rewind's success is counted once in `sum`, because that is
   *  what the code does. Printed alongside (i) so the parallel-schedule assumption the sum
   *  rests on is visible rather than buried in a table row that reads `0ms`. */
  const PARALLEL_EXTRA = lsRemoteCeiling(READ_HELPER, "the serialised half of the post-push pair", HELPER_RETURN);
  // Both numbers read with their env keys ABSENT, so the case measures what a shipped run
  // is cut at rather than what this suite or an operator's shell pins.
  const defaults = await (async () => {
    let seen = { bound: 0, allowance: 0, grace: 0 };
    await withEnv(
      {
        PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: undefined,
        PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: undefined,
      },
      async () => {
        seen = {
          bound: handoffReportBoundMs(),
          allowance: handoffAllowanceMs(),
          grace: childBoundGraceMs(),
        };
      },
    );
    return seen;
  })();
  const { bound: defaultBound, allowance: defaultAllowance, grace: defaultGrace } = defaults;
  // The bound is the allowance plus a POSITIVE headroom. Asserted apart from (i): the sum
  // is over the allowance, so an implementation that quietly dropped the headroom term and
  // compared against the wrong number would otherwise pass (i) anyway.
  assert(
    defaultBound > defaultAllowance,
    `(f) the bound is the allowance plus headroom, not the allowance itself (bound ${String(defaultBound)}ms, allowance ${String(defaultAllowance)}ms) — the path's ceilings sum past the allowance, so an equal bound cuts a progressing report`,
  );

  const table = awaits
    .map((a) => `  ${String(a.ms).padStart(7)}ms  ${a.what} [${a.where}]`)
    .join("\n");
  console.log(
    `(f) routed report's awaits, worst case:\n${table}\n  ${String(sum).padStart(7)}ms  TOTAL vs bound ${String(defaultBound)}ms (allowance ${String(defaultAllowance)}ms + headroom ${String(defaultBound - defaultAllowance)}ms; outer grace ${String(defaultGrace)}ms)`,
  );

  // (i) A slow-but-progressing report is never cut: every ceiling on the path fits inside
  // the bound. (ii) The run still stamps before the OUTER limit that would otherwise kill
  // it: the bound fires inside the child-bound grace, so an operator who set
  // `PI_ENSEMBLE_CHILD_BOUND_GRACE_MS` below the sum parks this case rather than silently
  // trading a report's verdict for a wrapper's kill. Both read the real constants, and both
  // messages name every number so a reader of a green suite never mistakes silence for a fit.
  //
  // ONE CAVEAT THE TABLE CANNOT HIDE, AND THE READER HAS TO CARRY: the pair of origin reads
  // that decide the rewind's success runs under `Promise.all`, so the sum counts ONE ceiling
  // for both. Serialised — any build where two concurrent `ls-remote` calls each reach their
  // own ceiling — the path is `PARALLEL_EXTRA` larger, and at the default constants that
  // serialised shape no longer fits between the allowance and the grace. (i) is therefore the
  // parallel-schedule reading of the path, which is what the code actually does.
  assert(
    sum <= defaultBound,
    `(f)(i) every per-call ceiling on the routed report's path must fit inside the bound that cuts it: summed ${String(sum)}ms against the bound ${String(defaultBound)}ms, i.e. the bound leaves ${String(defaultBound - sum)}ms of slack\n${table}`,
  );
  assert(
    defaultBound < defaultGrace,
    `(f)(ii) the bound must fire INSIDE the outer limit that would otherwise kill the run: bound ${String(defaultBound)}ms against the child-bound grace ${String(defaultGrace)}ms — at or past it no report ever times out, and every cut one is a kill instead of a handback`,
  );
  // The room the bound still has to the grace, printed so a reader who raises a per-call
  // ceiling sees how much of the window is left before (ii) parks the change.
  console.log(
    `(f) bound ${String(defaultBound)}ms sits ${String(defaultGrace - defaultBound)}ms inside the ${String(defaultGrace)}ms grace; serialised worst case ${String(sum + PARALLEL_EXTRA)}ms (the Promise.all pair adds ${String(PARALLEL_EXTRA)}ms)`,
  );
}


for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(state.exit);
