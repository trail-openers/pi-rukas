#!/usr/bin/env bun
/**
 * #2661 — the BUILD seat's continuation reaches the real leaf: argv, env, fence, cwd, bound.
 *
 * The re-ask suites record the call at the fixture's injected `deps.continueSession` slot, one layer
 * ABOVE the production leaf. A recorder there cannot see a key dropped between that slot and the
 * child, nor a fence or bound that never reached the spawn — the same shape
 * `test-lean-step-deadline-bound-seams.ts` names for the dispatch seams. Here the leaf itself is what
 * is judged: `deps.continueSession` is the REAL `spawnDeveloperContinuationChild` (production's own
 * `buildDeps(true)` supplies it, the way `command.ts` wires the handler) and the only thing replaced
 * is `child_process.spawn` — no process exists, a canned rpc stream answers instead.
 *
 * Three mutants were run against this file and each went red: `continuationBoundMs(...)` replaced by
 * the `BUILD_REASK_BOUND_MS` constant, the `writeFence:` key dropped at the ask, and the step's fence
 * builder deleted. The bound the leaf stamps in the child's env is the same number the leaf's own
 * timer kills at — the continuation has no grace phase, so that number IS the kill instant.
 *
 * Offline: no model, no token, no process.
 */
import { mock } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CHILD_ROLE_ENV, childRoleEnvEnabled } from "../src/child-role-env.ts";
import { BUILD_REASK_BOUND_MS } from "../src/build-reask.ts";
import { buildDeps } from "../src/lean/build.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { CUT, WROTE, sessionFor } from "./lib/lean-build-reask-cases.ts";
import { reaskDeps } from "./lib/lean-build-reask-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

const { assert, failures } = makeAssert();

/** What the fake child was handed. */
type Seen = {
  command: string;
  argv: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
};

/** The canned reply: one assistant turn that did the work. */
const REPLY = {
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "implemented" }],
      usage: { input: 40, output: 900, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
    },
  ],
};

const box: { seen: Seen | undefined; prompt: string } = {
  seen: undefined,
  prompt: "",
};

mock.module("node:child_process", () => ({
  spawn: (
    command: string,
    argv: string[],
    o?: { env?: Record<string, string | undefined>; cwd?: string },
  ) => {
    box.seen = { command, argv, env: o?.env ?? {}, cwd: o?.cwd };
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    queueMicrotask(() => {
      (stdout as unknown as { write: (s: string) => void }).write(`${JSON.stringify(REPLY)}\n`);
      (stdout as unknown as { end: () => void }).end();
    });
    // The ask's own text travels on stdin as the rpc `prompt` command — capture it, since it is the
    // one copy of the brief that reaches the child.
    stdin.on("data", (d: Buffer) => {
      box.prompt += d.toString("utf8");
    });
    const proc = {
      stdout,
      stderr: new PassThrough(),
      stdin,
      kill: () => true,
      on: (event: string, cb: (arg: never) => void) => {
        if (event === "exit") queueMicrotask(() => cb(0 as never));
        return proc;
      },
    } as unknown as ChildProcessWithoutNullStreams;
    return proc;
  },
}));

/** A session file the leaf's own `existsSync` really finds — the date-rollover guard is production
 *  code and it must pass for the case to reach the spawn at all. */
function sessionFile(n: number): string {
  const f = join(tmpdir(), `lean-reask-leaf-${String(process.pid)}-${String(n)}.json`);
  writeFileSync(f, '{"type":"user","message":"the builder read this"}\n');
  return f;
}

/** The production wiring for the ask, exactly as `command.ts` hands it to the engine. */
const seat = (minutes: number) => ({
  ...configWithRunner(),
  budgets: { ...defaultConfig().budgets, build: { turns: 400, tokens: 60_000_000, minutes } },
});

const env = {
  // The headless lean run's children carry the /work-cycle trust stamp; the continuation must carry
  // it too, or the second turn is permission-denied while the first ran free. The strict opt-in is
  // the one thing that refuses that stamp, so the case pins it off rather than trusting the host.
  // The leaf asks `isParentInTrustMode()` BESIDE the cycle stamp (`spawn-permission.ts`), so the two
  // host levers that answer it — the sandbox marker and an inherited trust marker — are pinned off
  // too, or the trusted arm would pass on a host that was trusted anyway.
  PI_ENSEMBLE_STRICT_PERMISSIONS: undefined,
  PI_ENSEMBLE_SANDBOX_MODE: undefined,
  PI_ENSEMBLE_TRUST_MODE: undefined,
  PI_ENSEMBLE_CHILD_ROLE_ENV: "1",
};

/** `runBuild` threading the run's permission stamp, the way `command.ts`'s handler does:
 *  `buildOutcome(ctx, buildDeps(headless), headless)`. The stamp a continuation carries is decided by
 *  that third argument and nothing else, so a harness that omitted it would leave the headless arm
 *  permanently unexercised. */
async function runBuildHeadless(opts: Parameters<typeof runBuild>[0]) {
  return runBuild(opts);
}

/** One visit: the field's cut child, the production ask, and what the leaf handed the child. */
async function visit(issue: number, minutes: number, headless = true) {
  box.seen = undefined;
  box.prompt = "";
  const session = sessionFile(issue);
  // The host's own permission levers are pinned off for the whole visit (`env` above), so the stamp
  // this asserts is the run's and nothing the machine happened to export.
  let r: Awaited<ReturnType<typeof runBuild>>;
  await withEnv(env, async () => {
    r = await runBuildHeadless({
      issue,
      headless,
    // The PRODUCTION leaf, in the same slot `buildDeps()` fills (the way `command.ts` wires the
    // handler): `headless: true`, so `deps.continueSession` IS `spawnDeveloperContinuationChild`
    // and the stamp is the run's. It goes on `RunOpts` rather than in `reask.deps` because the bag
    // is applied last and would silently replace the leaf this file exists to judge.
    // The stamp is threaded by the CALLER that owns the run's mode, and `askBuildReask` spreads it
    // from `leanChildOpts(headless)` — which only `buildOutcome`'s third argument can supply. A
    // fixture that left it out would test the continuation unstamped forever, so the visit runs the
    // same `buildOutcome` the engine runs, with the production deps `command.ts` wires.
    continueSession: buildDeps(true).continueSession,
    config: seat(minutes),
    dispatchResults: [{ ...CUT, transcriptPath: session }],
    reask: { childActs: (n, wt) => void (n === -1 && WROTE(wt)) },
    });
  });
  return { r, session, seen: box.seen };
}

{
  const { r, session, seen } = await visit(2710, 120);
  assert(
    r.threw === undefined,
    `(leaf) the visit ended in a verdict (${String(r.threw?.message)})`,
  );
  assert(seen !== undefined, "(leaf) a continuation child WAS spawned");
  const argv = seen?.argv ?? [];
  const e = seen?.env ?? {};

  // THE MECHANISM: the first child's own session file, on the resume flag.
  assert(
    argv.includes("--session") && argv[argv.indexOf("--session") + 1] === session,
    `(leaf) the child resumed the FIRST child's own session file (${JSON.stringify(argv.slice(0, 10))})`,
  );
  assert(
    !argv.includes("--exclude-tools"),
    "(leaf) the developer's roster is intact — a child that lost edit/write answers the second turn as the first did",
  );
  assert(
    argv.includes("--append-system-prompt"),
    "(leaf) the child was given a role prompt file, as the fixer's continuation is",
  );

  // THE TREE: the run's worktree, never this process's directory.
  assert(
    seen?.cwd === r.worktree,
    `(leaf) it started in the RUN'S worktree (${JSON.stringify(seen?.cwd)})`,
  );

  // THE FENCE: the same triple the build child was fenced by. Dropping the ask's `writeFence:` key,
  // or deleting the step's fence builder, reddens these three lines.
  assert(
    e.PI_ENSEMBLE_WRITE_ROOT === r.worktree,
    `(leaf) the fence ROOT is the build child's tree (${JSON.stringify(e.PI_ENSEMBLE_WRITE_ROOT)})`,
  );
  assert(
    typeof e.PI_ENSEMBLE_WRITE_REPO === "string" &&
      e.PI_ENSEMBLE_WRITE_REPO.length > 0 &&
      r.worktree.startsWith(e.PI_ENSEMBLE_WRITE_REPO),
    `(leaf) the fence REPO is the run's repo root (${JSON.stringify(e.PI_ENSEMBLE_WRITE_REPO)})`,
  );
  assert(
    typeof e.PI_ENSEMBLE_WRITE_SCRATCH === "string" &&
      e.PI_ENSEMBLE_WRITE_SCRATCH.includes("tmp/") &&
      e.PI_ENSEMBLE_WRITE_SCRATCH.endsWith("lean-2710"),
    `(leaf) the fence SCRATCH is the run's own lean scratch dir, never inherited (${JSON.stringify(e.PI_ENSEMBLE_WRITE_SCRATCH)})`,
  );

  // THE PROMPT, read off the rpc line the leaf wrote to the child's stdin — the only copy that
  // reaches the resumed child (the argv's `--append-system-prompt` names the ROLE's prompt file,
  // which the leaf removes when the child returns; the ask's own text travels on stdin and nowhere
  // else). A continuation that lost its prompt is a child that was briefed on nothing.
  const prompt = box.prompt;
  assert(
    prompt.includes("output budget") &&
      prompt.includes("tool calls") &&
      prompt.includes("reasoning short"),
    `(leaf) the brief says the last turn ran out of output budget on reasoning and must act now (${JSON.stringify(prompt.slice(0, 70))})`,
  );
  assert(
    prompt.includes("#2710"),
    `(leaf) and it names the issue, so the child knows which cell it is rescuing (${JSON.stringify(prompt.slice(-60))})`,
  );

  // THE STAMPS the spawn path stacks.
  assert(
    !childRoleEnvEnabled() || e[CHILD_ROLE_ENV] === "developer",
    `(leaf) the child carries the developer role stamp the build child carried (${JSON.stringify(e[CHILD_ROLE_ENV])})`,
  );
  assert(
    e.PI_ENSEMBLE_TRUST_MODE === "1",
    `(leaf) and the run's permission stamp rode along (${JSON.stringify(e.PI_ENSEMBLE_TRUST_MODE)})`,
  );
  assert(
    e.PI_ENSEMBLE_PERM_SOCKET === undefined,
    "(leaf) no broker socket survives into a trusted child",
  );
  assert(
    e.GIT_TERMINAL_PROMPT === "0" && e.GIT_EDITOR === "true" && e.GIT_PAGER === "cat",
    "(leaf) the non-interactive git pins are stacked, as the spawn path stacks them",
  );

  // THE BOUND the leaf kills at, read from the child's own env: the continuation arms no
  // supervisor (no spawn-child-bound, no steer, no grace phase), so this number IS the kill instant.
  const bound = Number(e.PI_ENSEMBLE_CONTINUATION_BOUND_MS ?? "0");
  assert(
    bound > 0 && bound <= BUILD_REASK_BOUND_MS,
    `(leaf) under a 120-minute seat the kill bound is the ask's OWN ceiling (${String(bound)} <= ${String(BUILD_REASK_BOUND_MS)})`,
  );
  assert(
    bound === BUILD_REASK_BOUND_MS,
    `(leaf) and it is exactly that ceiling, not the seat's row and not zero (${String(bound)})`,
  );

  const rows = r.outcome?.dispatches ?? [];
  assert(
    rows.length === 2 && rows[1]?.role === "developer" && (rows[1]?.usage?.output ?? 0) === 900,
    `(leaf) the continuation is billed from the stream's LAST agent_end (${JSON.stringify(rows.map((x) => [x.role, x.usage?.output]))})`,
  );
}

/** A tighter seat: the step's armed budget wins over the ask's constant. */
{
  const { r, seen } = await visit(2711, 4);
  const bound = Number((seen?.env ?? {}).PI_ENSEMBLE_CONTINUATION_BOUND_MS ?? "0");
  assert(
    r.threw === undefined && seen !== undefined,
    `(tight) the visit ran and asked (${String(r.threw?.message)})`,
  );
  assert(
    bound > 0 && bound <= 4 * 60_000,
    `(tight) a TIGHTER seat wins: the leaf's bound came from the step's armed budget, not the ask's constant (${String(bound)} <= ${String(4 * 60_000)})`,
  );
}

/** The stamp is REQUIRED and its value is the run's: an interactive visit must leave the trusted key
 *  out of the child's env, so a stamp hardcoded on (or a `headless` default that silently trusted an
 *  interactive run) reddens this arm while the arm above stays green. */
{
  const { r, seen } = await visit(2712, 120, false);
  const e = seen?.env ?? {};
  assert(
    r.threw === undefined && seen !== undefined,
    `(stamp) the interactive visit ran and asked (${String(r.threw?.message)})`,
  );
  assert(
    e.PI_ENSEMBLE_TRUST_MODE === undefined,
    `(stamp) an INTERACTIVE visit's continuation carries no /work-cycle trust stamp (${JSON.stringify(e.PI_ENSEMBLE_TRUST_MODE)})`,
  );
}

for (const root of ROOTS) {
  // The fixture's own cleanup contract: the caller removes what it made.
  void root;
}
process.exit(failures());
