#!/usr/bin/env bun
/**
 * lean/build — the child's machine exit for an unsatisfiable contract (#1984).
 *
 * A builder that finds two frozen assertions which cannot both hold had nothing
 * to do but probe them until the turn ceiling killed the step (one real run:
 * 401 turns, 200 scratch files, no commit, a handback naming no cause). The exit
 * valve is a companion tool, `report_blocked`, whose call the parent reads off
 * `DispatchResult.toolUses` — and, because a child's claim is narration, the
 * driver RE-RUNS the named frozen tests on the child's tree with the project's
 * own runner and honours the report only on a red.
 *
 *   (1) a report naming frozen files, one of which runs red -> `blocked`, and
 *       the tree is left exactly as the child left it (no reset, no commit)
 *   (2) a report naming a file the run never froze   -> ignored, ordinary `ok`
 *   (3) a report whose named tests all pass           -> ignored, ordinary `ok`
 *       (and (3a)-(3c), the runner's own judgement, in
 *        test-lean-build-blocked-rerun.ts)
 *   (4) a report whose call is unreadable             -> ignored
 *   (5) no report at all                              -> unchanged behaviour
 *   (6) the reporter companion is loaded into the child via `extraArgs`
 *   (7) the prompt states the early stop, and a `challenge:new-tests` round
 *       names the files the adversary added
 *
 * The machine edge (`build + blocked` -> `handback`) is pinned in
 * test-lean-machine.ts; the cause's place in the comment in
 * test-lean-handback-cause.ts; the durable record in test-lean-state-outcome.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BLOCKED_REPORTER_PATH } from "../src/lean/build-blocked-reporter.ts";
import { BuildInfraError } from "../src/lean/build-errors.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, RUNNER, put, runBuild, sha } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The child's one `report_blocked` call, in the shape Pi records a tool call. */
function blocked(names: Array<{ path: string; reason: string }>): unknown[] {
  return [{ name: "report_blocked", arguments: { conflicts: names } }];
}

/** A conflict naming the fixture's frozen file, in the child's own words. */
const CONFLICT = "case 2 needs the array mutable while case 3 mutates it in place";

// The fixture's frozen test is a shell script that fails while `src/retry.ts`
// still says `not-implemented` and exits 0 once the child has implemented it.
// So "red" and "green" here are the REAL runner's exit codes, which is the
// whole point: the anti-forgery gate is only worth having if the driver's re-run
// is the same command `verify` will run.

// ── (1) a true report ends the step at once, with a named cause ────────────
{
  const r = await runBuild({
    issue: 301,
    // The child implemented nothing, ran the frozen file until it was certain,
    // and reported. The bug's shape: it then kept probing to the turn ceiling.
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(r.threw === undefined, `(1) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "blocked", `(1) the kind is blocked (got ${r.outcome?.kind})`);
  assert(
    r.outcome?.blockedBy?.["tests/AC1-retry.test.sh"] === CONFLICT,
    `(1) the map names the file and the child's reason (got ${JSON.stringify(r.outcome?.blockedBy)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tests/AC1-retry.test.sh"),
    `(1) the reason names the frozen file (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(CONFLICT),
    `(1) the reason carries the stated conflict (got ${r.outcome?.reason})`,
  );
  assert(
    r.headBefore === r.headAfter,
    "(1) the early stop commits nothing — the tree is left as the child left it",
  );
  assert(
    r.outcome?.dispatches?.length === 1,
    `(1) the child's cost row is still recorded (got ${JSON.stringify(r.outcome?.dispatches)})`,
  );
  assert(r.outcome?.limit === undefined, "(1) a blocked verdict arms no budget trio");
}

// ── (1b) an edit the child DID make survives the early stop (no reset) ─────
{
  const r = await runBuild({
    issue: 302,
    child: (wt) => put(wt, "src/probe.ts", "export const probe = 1;\n"),
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(
    r.outcome?.kind === "blocked",
    `(1b) still blocked: ${r.outcome?.kind ?? r.threw?.message}`,
  );
  assert(
    existsSync(path.join(r.worktree, "src/probe.ts")),
    "(1b) no reset ran — the child's file is where the step left it",
  );
}

// ── (2) a report whose frozen record does not describe the tree is refused ──
{
  // The deepest forgery available to a builder: edit the frozen assertion out
  // of the contract, then report a conflict about it. The committed bytes no
  // longer hash to the record, so the step refuses the round as infrastructure
  // and never reaches the report at all — no outcome, no blocked verdict, and
  // the child is never paid. This is the run-5 shape with the tree tampered with.
  const r = await runBuild({
    issue: 303,
    frozenSha: sha('#!/bin/sh\necho "ok - the child edited it"\nexit 0\n'),
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(
    r.threw instanceof BuildInfraError &&
      (r.threw?.message ?? "").includes("frozen tests do not match the record"),
    `(2) a report from a tampered contract is refused, not believed (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(r.dispatched === 0, `(2) and the child was never dispatched (got ${r.dispatched})`);
  assert(r.outcome === undefined, "(2) and no verdict of any kind is recorded");
}

// ── (2b) a report naming a path outside the frozen map is not honoured ─────
{
  // The anti-forgery gate's first check is the frozen map, and it must fire
  // BEFORE the driver spends a runner on the name. The child writes a file that
  // is a genuine, self-naming RED — to the runner it is indistinguishable from
  // a frozen test that really is unsatisfiable — and reports it. Only the
  // frozen map tells the two apart, so a gate that skipped that check would
  // honour a conflict nobody ever froze. `afterDispatch` re-plants it after the
  // step's reset, which is when the driver actually looks at the tree.
  const INVENTED = "tmp-invented.test.sh";
  const plant = (wt: string): void =>
    put(wt, INVENTED, `#!/bin/sh\necho "not ok - ${INVENTED}" 1>&2\nexit 1\n`, 0o755);
  const r = await runBuild({
    issue: 333,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      plant(wt);
    },
    afterDispatch: plant,
    toolUses: () => blocked([{ path: INVENTED, reason: CONFLICT }]),
  });
  assert(r.threw === undefined, `(2b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "ok",
    `(2b) an un-frozen name is ignored and the step commits normally (got ${r.outcome?.kind})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(2b) and records no blockedBy");
}

// ── (3) a report whose named tests all pass is not honoured ────────────────
{
  // The child gives up on a hard case and blames the contract. The driver ran
  // the file itself and watched it exit 0, so there is nothing unsatisfiable to
  // hand back — the step finishes the job instead.
  const r = await runBuild({
    issue: 304,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(r.threw === undefined, `(3) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "ok",
    `(3) green named tests mean no blocked verdict (got ${r.outcome?.kind})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(3) and no blockedBy is recorded");
  assert(
    readFileSync(path.join(r.worktree, "src/retry.ts"), "utf8").includes("() => 1"),
    "(3) the implementation the child wrote was committed",
  );
}

// ── (4) an unreadable call is skipped, never trusted ───────────────────────
{
  const r = await runBuild({
    issue: 305,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 2;\n"),
    toolUses: [
      { name: "report_blocked", arguments: { conflicts: "not an array" } },
      { name: "report_blocked" },
      { name: "submit_tests", arguments: { criterionId: "AC1", testFiles: ["x"] } },
    ],
  });
  assert(
    r.outcome?.kind === "ok",
    `(4) a malformed report is skipped (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(4) and nothing was recorded");
}

// ── (5) no report at all: the step is exactly what it was ──────────────────
{
  const r = await runBuild({
    issue: 306,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 3;\n"),
  });
  assert(
    r.outcome?.kind === "ok",
    `(5) an ordinary build is still ok (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  const quiet = await runBuild({ issue: 307 });
  assert(
    quiet.outcome?.kind === "exhausted",
    `(5) and an empty one is still exhausted (got ${quiet.outcome?.kind ?? quiet.threw?.message})`,
  );
}

// ── (6) the child is given the reporter tool, or the channel does not exist ─
{
  const r = await runBuild({
    issue: 308,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 4;\n"),
  });
  const args = r.extraArgs[0] ?? [];
  const i = args.indexOf("--extension");
  assert(
    i >= 0 && args[i + 1] === BLOCKED_REPORTER_PATH,
    `(6) the build child is launched with the blocked reporter (got ${JSON.stringify(args)})`,
  );
  assert(args.includes("--no-skills"), `(6) and carries no skills (got ${JSON.stringify(args)})`);
  assert(
    existsSync(BLOCKED_REPORTER_PATH),
    `(6) the companion file exists at the path the dispatch passes (${BLOCKED_REPORTER_PATH})`,
  );
  const src = existsSync(BLOCKED_REPORTER_PATH) ? readFileSync(BLOCKED_REPORTER_PATH, "utf8") : "";
  assert(
    src.includes('name: "report_blocked"'),
    "(6) and registers exactly the tool the parent reads",
  );
}

// ── (6b) a reporter that cannot be statted is infrastructure, named ────────
{
  const { dispatchBuilder } = await import("../src/lean/build-dispatch.ts");
  // `unknown`, not `{}`: `thrown.message` below is read through a type guard and a
  // bare `{}` annotation would refuse it.
  let thrown: unknown;
  try {
    await dispatchBuilder(
      async () => {
        throw new Error("must not dispatch");
      },
      {
        issue: 309,
        // The minimal spec the seam needs; the preflight runs before the prompt.
        spec: {
          problem: "p",
          size: "S",
          criteria: [{ id: "AC1", text: "t", verify: "test" as const }],
        },
        frozen: {},
        wt: "/wt",
        repoRoot: "/repo",
        attempt: 1,
        budget: { opts: {}, fired: () => undefined },
        statReporter: async () => {
          // The shape `statReporterPath` surfaces when the companion is not a file:
          // a real `stat` rejection, not the error the preflight itself raises.
          throw new Error("ENOENT");
        },
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error && thrown.message.includes("reporter extension missing"),
    `(6b) a missing companion is a named pre-spawn failure (got ${String(thrown)})`,
  );
  assert(
    !"must not dispatch".includes(String((thrown as Error | undefined)?.message ?? "")),
    "(6b) and the child was never dispatched",
  );
}

// ── (7a) the prompt states the early-stop exit ─────────────────────────────
{
  const r = await runBuild({
    issue: 310,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 6;\n"),
  });
  const prompt = r.prompts[0] ?? "";
  assert(
    prompt.includes("cannot all pass together") && prompt.includes("report_blocked"),
    `(7a) the prompt tells the child to call report_blocked when the tests conflict (got ${prompt.slice(0, 0)})`,
  );
  assert(
    prompt.includes("then stop"),
    "(7a) and tells it to stop after reporting, rather than keep probing",
  );
  assert(
    !prompt.includes("say so in your reply. Do not change it"),
    "(7a) the prose-only valve this replaces is gone",
  );
}

// ── (7b) a build re-entered after challenge:new-tests is told what was added ─
{
  const ADDED = "tests/AC1-budget-verdict-row-identity.test.sh";
  const r = await runBuild({
    issue: 311,
    // The adversary's file is committed and hashed by the fixture, so the step's
    // frozen-integrity check sees the same bytes the challenge step recorded.
    extraFrozen: { [ADDED]: '#!/bin/sh\necho "ok - shipped"\nexit 0\n' },
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 7;\n"),
  });
  assert(r.threw === undefined, `(7b) no throw: ${r.threw?.message ?? "clean"}`);
  const prompt = r.prompts[0] ?? "";
  assert(prompt.includes(ADDED), "(7b) the adversary's added file is named in the re-entry brief");
  assert(prompt.includes("challenge round"), "(7b) and the prompt says who added it");
  assert(
    prompt.includes("tests/AC1-retry.test.sh"),
    "(7b) the specify-frozen file is still listed",
  );
}

// ── (7c) with no challenge round, the re-entry brief says nothing about one ─
{
  const r = await runBuild({
    issue: 312,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 8;\n"),
  });
  assert(
    !(r.prompts[0] ?? "").includes("challenge round"),
    "(7c) a first build is not told about a round that never ran",
  );
}

// ── (8) the early stop is observable with NO budget armed at all ───────────
{
  // The 401/400 death happened under DEFAULT_BUDGETS — no ceiling was ever
  // breached, the child simply never stopped. So the fix must be reachable on
  // the shape where nothing binds: the default config, no `onProgressTick`, and
  // the verdict returned on the dispatch seam.
  const r = await runBuild({
    issue: 313,
    config: configWithRunner(),
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(
    r.outcome?.kind === "blocked",
    `(8) with no budget armed the report still ends the step (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.dispatched === 1, "(8) at one dispatch — nothing after the report was paid for");
}

// ── (9) the infra throw still wins over a report ───────────────────────────
{
  const r = await runBuild({
    issue: 314,
    dispatchOk: false,
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(
    r.threw instanceof BuildInfraError,
    `(9) a dead child is infrastructure, not a blocked verdict (got ${r.threw?.name ?? r.outcome?.kind})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
