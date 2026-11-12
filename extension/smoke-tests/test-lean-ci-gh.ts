#!/usr/bin/env bun
/**
 * lean/ci — the step cannot report a green it did not observe, against REAL `gh`
 * payloads rather than a seam shaped to match its parser.
 *
 * `test-lean-ci.ts` drives the step through an injected recorder whose replies the
 * test itself writes. That is the right shape for verdicts, and it is also why a
 * whole class of bug survives it: if the seam and the parser agree on a field the
 * CLI does not emit, the suite is green and production reads nothing. So every
 * case below answers the pinned argv with a payload captured from a real
 * `gh` 2.102.0 (`lib/lean-gh-payloads.ts`), and the assertions are about what the
 * step OBSERVED, not about what it was handed.
 *
 * The witnesses this file exists for:
 *
 *   (w1) a `ci` that read NOTHING cannot return green — with `gh` unavailable and
 *        no full tier configured it comes back RED naming the missing tier, and
 *        with `gh` unavailable and a tier configured it THROWS. There is no path
 *        through this step to a green that did not run both halves;
 *   (w2) the real `gh pr checks` rows parse: real passing rows -> green with the
 *        tier actually executed; a real `skipping`/`SKIPPED` row -> red, so the
 *        `skipped`-is-not-green rule is reachable through production argv;
 *   (w3) a table-form `gh pr checks` reply (what `--json` prevents) is NOT read as
 *        zero checks and NOT read as green — it throws, so the missing flag reads
 *        as infrastructure rather than as a verdict;
 *   (w4) the view read is one read, and the head equality is judged from it: a
 *        real reply whose `mergeStateStatus` is not CLEAN is a red, never a green;
 *   (w5) `notBuilt` is unreachable for `ci` and `land` while an unbuilt stage
 *        still answers with the stub — a mis-wired handler and a genuinely unbuilt
 *        one stay distinguishable.
 *
 * Offline throughout: the forge is a recorder answering the pinned argv with real
 * captured payloads, the tier is an `sh` command, no PR and no merge exist.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { Forge } from "../src/forge-types.ts";
import type { CiDeps } from "../src/lean/ci-deps.ts";
import { ghReads } from "../src/lean/ci-deps.ts";
import { ciOutcome } from "../src/lean/ci.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { Budget } from "../src/lean/config.ts";
import type { Outcome } from "../src/lean/state.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";
import {
  REAL_CHECKS_FAIL,
  REAL_CHECKS_PASS,
  REAL_CHECKS_PENDING,
  REAL_CHECKS_SKIPPED,
  REAL_CHECKS_TABLE,
  realPrViewReply,
} from "./lib/lean-gh-payloads.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Case {
  /** The full tier the config names; absent means the project configured none. */
  full?: string;
  /** The `gh pr view` reply; a string is returned verbatim (table/garbage form). */
  view?: unknown;
  /** The `gh pr checks` reply; a string is returned verbatim. */
  checks?: unknown;
  /** `gh` does not run at all (not installed, no network, refused). */
  ghDown?: boolean;
  /** Reject the tier's exec (a kill or an un-startable runner). */
  tierFails?: unknown;
  /** The tier runs and exits non-zero. */
  tierExit?: number;
  noTierAtAll?: boolean;
  /** A porcelain line the tree reports, so the clean-tree gate can be made to bite. */
  dirty?: string;
  /** The name of an untracked file to actually write into the worktree. */
  dirtyFile?: string;
  /** The sha the worktree's HEAD holds, in place of the verified one. `"moved"`
   *  puts it on a real second commit in the repo. */
  headOnDisk?: string;
  /** HEAD answers with no branch at all (a detached tree). */
  detached?: boolean;
  /** The wait's bound in ms, so a budget case does not wait 30 real minutes. */
  waitTimeoutMs?: number;
  /** The full tier's bound in ms; `null` leaves the seam unset so the step takes
   *  its own `budgets.ci.minutes` through `ciMinutes`. */
  tierTimeoutMs?: number | null;
  /** The `budgets.ci` row the injected config carries. The wait bound and the
   *  tier's bound both come from here, so a case can prove which number the step
   *  actually read. */
  ciBudget?: Budget;
}

/** Run one git command in the fixture's real repo and report what git really says. */
function realGit(cwd: string, argv: string[]): { stdout: string } {
  const r = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      ...gitTestEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return { stdout: r.stdout ?? "" };
}

interface Ran {
  /** Every command the step asked the executor to run, in order. */
  cmds: string[];
  /** How many times the full tier command ran. */
  tierRuns: number;
}

/**
 * Drive `ci` with a recorder that answers the PINNED argv with real gh payloads.
 *
 * The recorder refuses to answer a `gh` read that the pinned argv does not ask
 * for, so a step that quietly changed its own command would get nothing back
 * rather than a helpful reply.
 */
async function run(c: Case): Promise<{
  outcome?: Outcome;
  threw?: Error;
  ran: Ran;
  /** How many `gh pr checks` reads ran, and how many waits the poll took. Both
   *  are per-POLL witnesses: a step that read the forge once per step instead of
   *  once per wait would show one of each. */
  checks: number;
  slept: number[];
  wt: string;
  head: string;
}> {
  const f = ciLandLog(900 + Math.floor(Math.random() * 90000), {
    ...(c.headOnDisk === undefined
      ? {}
      : { worktreeHead: c.headOnDisk === "moved" ? "other" : c.headOnDisk }),
    ...(c.detached === true ? { detached: true } : {}),
    ...(c.dirtyFile === undefined ? {} : { dirtyFile: c.dirtyFile }),
  });
  const tier = c.full ?? "";
  const ran: Ran = { cmds: [], tierRuns: 0 };
  const slept: number[] = [];
  const reads = ghReads(77);
  let checksReads = 0;
  const deps: CiDeps = {
    exec: async (cmd, o) => {
      ran.cmds.push(cmd);
      if (cmd === tier && tier !== "") {
        ran.tierRuns++;
        if (c.tierFails !== undefined) throw c.tierFails;
        if (c.tierExit !== undefined)
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            code: c.tierExit,
            stdout: "",
            stderr: "boom from the full tier\n",
          });
        return { stdout: "" };
      }
      if (cmd === reads.view || cmd.startsWith("gh pr view ")) {
        if (c.ghDown === true) throw new Error("gh: could not reach the API");
        return {
          stdout:
            typeof c.view === "string"
              ? c.view
              : realPrViewReply(f.head, (c.view ?? {}) as Record<string, unknown>),
        };
      }
      if (cmd === reads.checks || cmd.startsWith("gh pr checks ")) {
        if (c.ghDown === true) throw new Error("gh: could not reach the API");
        checksReads++;
        return {
          stdout:
            typeof c.checks === "string" ? c.checks : JSON.stringify(c.checks ?? REAL_CHECKS_PASS),
        };
      }
      // The disk re-reads go to the fixture's OWN repo, through real git — every
      // one of them, including HEAD. A scripted `rev-parse` would make the whole
      // of (w6) a rehearsal: the step would be graded against a head the test
      // asserted rather than a disk it read, and a no-op gate would stay green.
      if (cmd === "git") return realGit(String(o?.cwd ?? f.repoRoot), (o?.argv ?? []) as string[]);
      return { stdout: "" };
    },
    loadConfig: async () => ({
      ...defaultConfig(),
      verify: c.noTierAtAll === true || c.full === undefined ? {} : { full: c.full },
      ...(c.ciBudget === undefined
        ? {}
        : { budgets: { ...defaultConfig().budgets, ci: { ...c.ciBudget } } }),
    }),
    ...(c.tierTimeoutMs === null ? {} : { tierTimeoutMs: c.tierTimeoutMs ?? 5_000 }),
    ...(c.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: c.waitTimeoutMs }),
    // The injected sleep MOVES the clock the wait is bounded by — the shape
    // `test-forge-ci-watch.ts` drives `ciWatch` with. A sleep that only slept
    // would let the bound never expire and the case would hang. The gh reads
    // arrive with `verifyHostEnv()`; the recorder ignores it — what the step
    // asks the executor for is asserted in `test-verify-child-env-paths.ts`.
    sleep: async (ms) => {
      slept.push(ms);
      f.tick(ms);
    },
    now: () => f.ctx.now(),
    // The GitHub adapter. The step reads the forge through the adapter seam (the
    // real one is `io.ts`'s `forgeFor`); a `github` adapter is what keeps the two
    // pinned `gh` reads the reads this suite answers with its captured payloads,
    // and (w5) is the case that says an unreadable `gh` is never a green.
    forge: async () => ({ forge: "github" }) as unknown as Forge,
  };
  try {
    return {
      outcome: await ciOutcome(f.ctx, deps),
      ran,
      slept,
      checks: checksReads,
      wt: f.repoRoot,
      head: f.head,
    };
  } catch (err) {
    return { threw: err as Error, ran, slept, checks: checksReads, wt: f.repoRoot, head: f.head };
  }
}

// ── (w1) a ci that read nothing cannot be green ───────────────────────────
{
  // No full tier configured AND gh down: the step's first refusal is the missing
  // tier, and it never reached the forge at all. A red naming the half that is
  // missing — not a green, and not a silent pass.
  const r = await run({ ghDown: true, noTierAtAll: true });
  assert(
    r.outcome?.kind === "red",
    `(w1) gh down + no full tier -> RED, never green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("no full verify tier"),
    `(w1) the red names the half that is missing (${r.outcome?.reason})`,
  );
  assert(
    r.ran.cmds.every((c) => !c.startsWith("gh ")),
    "(w1) the forge was never asked — there was no green on offer",
  );
}
{
  // gh down WITH a tier configured: the forge half is unestablished, so this is
  // infrastructure (a handback), never a green and never a fix round.
  const r = await run({ full: "true", ghDown: true });
  assert(
    r.threw instanceof VerifyInfraError,
    `(w1) gh down + a tier configured THROWS (${String(r.threw?.message)})`,
  );
  assert(r.outcome === undefined, "(w1) and records no verdict the machine could route");
  assert(r.ran.tierRuns === 0, "(w1) the tier never ran over a forge nobody read");
}
{
  // A tier whose runner vanished from disk is infra too — not the red a good PR
  // would be marked with.
  const r = await run({
    full: "true",
    tierFails: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(w1) a tier whose runner vanished THROWS rather than marking a good PR red (${String(r.threw?.message)})`,
  );
}

// ── (w2) real gh payloads parse both ways ────────────────────────────────
{
  const r = await run({ full: "true", checks: REAL_CHECKS_PASS });
  assert(
    r.outcome?.kind === "green",
    `(w2) real gh rows + a passing tier -> green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(r.ran.tierRuns === 1, "(w2) and the full tier actually ran, exactly once");
  assert(
    r.ran.cmds.some((c) => c.includes("--json")),
    "(w2) the gh reads asked for --json, which is the only form that parses",
  );
}
{
  const r = await run({ full: "true", checks: REAL_CHECKS_SKIPPED });
  assert(
    r.outcome?.kind === "red",
    `(w2) a real skipping row is not green (${JSON.stringify(r.outcome)})`,
  );
  assert((r.outcome?.reason ?? "").includes("publish-image"), "(w2) and the red names it");
  assert(r.ran.tierRuns === 0, "(w2) the tier was not run over a CI nobody passed");
}
{
  const r = await run({ full: "true", checks: REAL_CHECKS_FAIL });
  assert(r.outcome?.kind === "red", "(w2) a real failing row is red");
  assert((r.outcome?.reason ?? "").includes("quality-gate"), "(w2) naming the failing check");
}
{
  // The real PENDING rows are the state this step exists to wait out, so the
  // wait is exercised against captured gh output too: the poll re-reads rather
  // than grading UNSTABLE as red, and a check that never arrives hands back.
  const r = await run({
    full: "true",
    waitTimeoutMs: 150_000,
    view: { mergeStateStatus: "UNSTABLE" },
    checks: REAL_CHECKS_PENDING,
  });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw?.message ?? "").includes("still pending"),
    `(w2) real pending rows are waited, never graded red (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("offline-smoke"),
    `(w2) and the handback names the rows that never finished (${String(r.threw?.message)})`,
  );
  assert(
    r.checks === 4 && r.slept.length === 3,
    `(w2) both reads run at the top of every iteration, so the last one sees the bound (${String(r.checks)} reads, ${String(r.slept.length)} waits)`,
  );
  assert(r.ran.tierRuns === 0, "(w2) no tier ran over a CI that had not finished");
}

// ── (w3) the table form --json prevents is not read as "no checks" ───────
{
  const r = await run({ full: "true", checks: REAL_CHECKS_TABLE });
  assert(
    r.threw instanceof VerifyInfraError,
    `(w3) a human-table gh reply THROWS — it is not evidence of anything (${String(r.threw?.message)})`,
  );
  assert(
    r.outcome?.kind !== "green",
    "(w3) and above all it is not the green the step would have reported",
  );
}

// ── (w4) one read carries the head AND the verdict ───────────────────────
{
  const r = await run({ full: "true", view: { mergeStateStatus: "BLOCKED" } });
  assert(
    r.outcome?.kind === "red",
    `(w4) mergeStateStatus BLOCKED -> red (${JSON.stringify(r.outcome)})`,
  );
  assert((r.outcome?.reason ?? "").includes("BLOCKED"), "(w4) carrying the forge's own word");
  assert(r.ran.tierRuns === 0, "(w4) the tier never ran over a blocked PR");
}
{
  // A real reply whose head is another commit: red naming both oids, and the one
  // `gh pr view` in the log proves head and verdict came from the same read.
  const other = "c".repeat(40);
  const r = await run({ full: "true", view: { headRefOid: other } });
  assert(r.outcome?.kind === "red", `(w4) a moved PR head -> red (${JSON.stringify(r.outcome)})`);
  assert(
    (r.outcome?.reason ?? "").includes("is not the verified head"),
    `(w4) naming both oids (${r.outcome?.reason})`,
  );
  const views = r.ran.cmds.filter((c) => c.startsWith("gh pr view "));
  assert(
    views.length === 1 &&
      views[0]!.includes("mergeStateStatus") &&
      views[0]!.includes("headRefOid"),
    `(w4) the head and the verdict came from ONE read (${JSON.stringify(views)})`,
  );
}

// ── (w5) `ci` and `land` are wired; an unbuilt stage still says it is not ─
{
  const f = ciLandLog(555);
  // The step asks for a full tier BEFORE it reads the forge, so this case (which
  // runs the step with its real deps, and therefore with no forge adapter) still
  // reaches the tier sentence. The forge-first ordering is `test-lean-ci-gl.ts`'s
  // no-adapter case, which configures a tier precisely to reach the forge.
  const handlers = phase1Handlers(f.repoRoot, 555);
  const settled = await (handlers.ci as (c: never) => Promise<unknown>)(f.ctx as never).then(
    (o) => o,
    (e: unknown) => e,
  );
  const msg = settled instanceof Error ? settled.message : JSON.stringify(settled);
  assert(
    !String(msg).includes("not built yet"),
    `(w5) the ci handler is the step, not the stub (${msg})`,
  );
  // No `.pi/work.json` and no `.pi/verify-cmd` in the fixture repo, so the step's
  // own first sentence is the missing tier — a line only the real step writes.
  assert(
    (settled as Outcome)?.kind === "red" &&
      String((settled as Outcome)?.reason ?? "").includes("no full verify tier"),
    `(w5) and it reached its own refusal (${msg})`,
  );
  const landSettled = await (handlers.land as (c: never) => Promise<unknown>)(f.ctx as never).then(
    (o) => o,
    (e: unknown) => e,
  );
  const landMsg = landSettled instanceof Error ? landSettled.message : JSON.stringify(landSettled);
  assert(
    !String(landMsg).includes("not built yet"),
    `(w5) the land handler is the step, not the stub (${landMsg})`,
  );
  // And a stage that became real keeps answering with its OWN refusal, so the
  // two shapes above cannot be produced by a mis-wired table entry. `review` is
  // a real step on this branch (it landed before `ci`/`land`), so the sentence
  // it produces is the step's, not the stub's — the assertion is that it is NOT
  // `not built yet`, which is what the stub would have said.
  const review = await (handlers.review as (c: never) => Promise<unknown>)(f.ctx as never).then(
    String,
    (e: unknown) => (e as Error).message,
  );
  assert(
    !String(review).includes("not built yet"),
    `(w5) the review handler is the step, not the stub (${String(review).slice(0, 160)})`,
  );
}

// ── (w6) the disk gate bites: a moved head or a dirty tree cannot pass ───
{
  // HEAD no longer at the verified commit (someone checked out something else
  // between the build gate and this handler): the step must throw, not grade.
  // The tree is checked out to a REAL second commit, so this is a disk that moved
  // rather than a recorder told to say a different sha.
  const r = await run({ full: "true", headOnDisk: "moved" });
  assert(
    r.threw instanceof VerifyInfraError,
    `(w6) a tree checked out to another commit THROWS (${String(r.threw?.message)})`,
  );
  assert(r.ran.tierRuns === 0, "(w6) and the full tier never ran over it");
}
{
  // HEAD detached from the run's branch: same sha, no ref — the case a bare
  // head comparison cannot see.
  const r = await run({ full: "true", detached: true });
  assert(
    r.threw instanceof VerifyInfraError && String(r.threw?.message).includes("branch"),
    `(w6) a detached HEAD THROWS, naming the branch it lost (${String(r.threw?.message)})`,
  );
  assert(r.ran.tierRuns === 0, "(w6) no tier over a tree taken off its ref");
}
{
  // Uncommitted bytes in the tree: the clean-tree gate is lean's ONE porcelain
  // check, so this is the witness that `ci` actually calls it. The file is really
  // written, so the porcelain line is git's, not the test's.
  const r = await run({ full: "true", dirty: "?? stray.txt", dirtyFile: "stray.txt" });
  assert(
    r.threw instanceof VerifyInfraError && String(r.threw?.message).includes("dirty"),
    `(w6) uncommitted bytes THROWS rather than yielding a green (${String(r.threw?.message)})`,
  );
  assert(r.ran.tierRuns === 0, "(w6) the tier never ran over bytes no commit holds");
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
