#!/usr/bin/env bun
/**
 * `developer-session-continuation` — the resumed child IS the fixer's second turn, not a new child.
 *
 * The defect this closes is a fix wave that handed back "produced no change" over a fixer whose last
 * turn ended at the provider's output cap having made no edit. The remedy is one more prompt on THAT
 * session, in THAT tree, behind THAT fence. Every one of those four words is a field the child can get
 * wrong while the step still reports "we continued it", so each is asserted on the argv, the env and
 * the stdin the child was actually handed — not on what the caller intended.
 *
 *   (1) the argv: `--session <the fixer's file>` (the mechanism), the developer's role and prompt
 *       file, NO `--exclude-tools` (a developer's exclusion list is empty, and a child that lost
 *       `edit`/`write` would answer the second prompt exactly as the first one did), the guard
 *       companion, and the model choice the role resolves to
 *   (2) the env: the write fence the fixer ran behind, re-applied by name — root, repo and scratch —
 *       plus the role stamp and the non-interactive git pins; a resumed child with no fence is a child
 *       that can write anywhere the process can
 *   (3) `cwd`: the FIX TREE, and never the parent's directory — the field `test-lean-review-fixer-bound.ts`
 *       exists for on the re-ask child, for the same reason
 *   (4) the reply and the cost, read off the LAST `agent_end`: a resumed session REPLAYS the truncated
 *       turn, so the first child's own closing text and its 16 384-token turn must never be mistaken
 *       for the continuation's; and a stream that carried no final assistant turn yields no usage, so
 *       the row costs zero rather than a guessed number
 *   (5) the failure arms, each with its own reason: no session file, a child that printed nothing, a
 *       child the bound ended — and the one that must NOT be a pass, a child that exited non-zero
 *   (5b) the two pre-spawn refusals: a guard companion that cannot be resolved, and a role that is not
 *       the fixer's — each with no child spawned, and the role refusal traced with the role named
 *   (6) the bound handed to the child never exceeds the fixer's own ceiling
 *
 *
 *   (7) is a SIBLING FILE: the fixer's own dispatch (its clamped bound and its write fence, asserted
 *       on the options `deps.dispatch` received) is `test-lean-review-fixer-own-dispatch.ts`.
 *
 * The child is spawned through the injected `spawn` seam, so nothing here starts a pi, spends a token,
 * or reads a model's output.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ContinuationOutcome,
  continuationChildArgs,
  spawnDeveloperContinuationChild,
} from "../src/developer-session-continuation.ts";
import { continuationReplyText, lastAgentEndFinalTurn } from "../src/continuation-stream.ts";
import { continuationBoundMs } from "../src/fixer-truncation.ts";
import { KILL_GRACE_MS } from "../src/spawn-kill.ts";
import { FIX_BOUND_MS } from "../src/lean/review.ts";
import type { BudgetArms } from "../src/lean/step-budget.ts";
import {
  FENCE,
  agentEnd,
  child,
  disposables,
  scratch,
} from "./lib/lean-continuation-child.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import { cleanupRoots } from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

const baseArgs = (transcriptPath: string) => ({
  transcriptPath,
  role: "developer",
  cwd: FENCE.root,
  writeFence: { ...FENCE },
  boundMs: FIX_BOUND_MS,
  prompt: "Your previous turn was cut off — go straight to the edit.",
});

// ── (1) THE ARGV ──────────────────────────────────────────────────────────────
{
  const transcript = scratch("fixer-session.json");
  const fake = child([agentEnd({ text: "edited and committed", stopReason: "end_turn" })]);
  const out = await spawnDeveloperContinuationChild(baseArgs(transcript), { spawn: fake.spawn });
  assert(out.ok === true, `(1) the continuation answered (${JSON.stringify(out)})`);
  const { argv } = fake.seen();
  assert(
    argv[argv.indexOf("--session") + 1] === transcript,
    `(1) the child resumed the FIXER's session file — a new session is a second opinion, not a follow-up, and it is the one field that makes this a continuation at all (${JSON.stringify(argv.slice(0, 12))})`,
  );
  assert(
    argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "rpc",
    "(1) rpc mode, as the first child ran in",
  );
  assert(
    !argv.includes("--exclude-tools"),
    "(1) and NO tool exclusion — a fixer that lost edit/write would answer this prompt the way it answered the last one",
  );
  assert(
    argv.includes("--append-system-prompt"),
    "(1) and it carries the role's system prompt, so it is configured like the child it continues",
  );
  assert(
    argv.some((a) => a.includes("child-guards")),
    `(1) and the guard companion is loaded, so the fence it runs behind is enforced and not merely described (${JSON.stringify(argv)})`,
  );
  // The argv is built by the pure helper too, which is where the reviewer-role contrast is checked —
  // the module must not be usable to continue a REVIEWER with its write tools restored.
  const reviewerArgv = continuationChildArgs({
    transcriptPath: transcript,
    role: "adversarial-developer",
    promptFile: join(tmpdir(), "unused-prompt.md"),
  });
  assert(
    reviewerArgv.includes("--exclude-tools"),
    "(1) a reviewer role keeps its exclusion list — this module continues a DEVELOPER, and silently restoring a reviewer's write tools would be a different bug with the same mechanism",
  );
}

// ── (2) THE FENCE AND THE ENV ─────────────────────────────────────────────────
{
  const transcript = scratch("fixer-session-2.json");
  const fake = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  await spawnDeveloperContinuationChild(baseArgs(transcript), { spawn: fake.spawn });
  const { env } = fake.seen();
  assert(
    env.PI_ENSEMBLE_WRITE_ROOT === FENCE.root,
    `(2) the fence's root is the FIX TREE the first child ran in (${String(env.PI_ENSEMBLE_WRITE_ROOT)})`,
  );
  assert(
    env.PI_ENSEMBLE_WRITE_REPO === FENCE.repo,
    `(2) and its repo (${String(env.PI_ENSEMBLE_WRITE_REPO)})`,
  );
  assert(
    env.PI_ENSEMBLE_WRITE_SCRATCH === FENCE.scratch,
    `(2) and its scratch, so the resumed child is not fenced MORE narrowly than the child (${String(env.PI_ENSEMBLE_WRITE_SCRATCH)})`,
  );
  assert(
    env.PI_ENSEMBLE_ROLE === "developer",
    `(2) the role stamp is the fixer's own (${String(env.PI_ENSEMBLE_ROLE)})`,
  );
  assert(
    env.GIT_TERMINAL_PROMPT === "0" && env.GIT_EDITOR === "true",
    "(2) and git stays non-interactive — a child that reached a credential prompt or an editor would wait for a TTY it does not have",
  );
  // The permission stamp. A headless lean run's FIXER is trusted through the /work-cycle stamp, and
  // this child resumes that fixer's session and its edits integrate — a continuation that ran while
  // its parent was trusted is the divergence `leanChildOpts` exists to prevent, and the one this
  // dispatch path can get wrong silently, since it never goes through `spawnSpecialist`.
  //
  // Both arms pin the parent's shape: the marker is a UNION of two reasons
  // (`isParentInTrustMode()` OR the requested stamp) and the host running this may itself be
  // trusted, so the thing asserted is the one this seam controls.
  const PINS = {
    PI_ENSEMBLE_SANDBOX_MODE: undefined,
    PI_ENSEMBLE_TRUST_MODE: undefined,
    PI_ENSEMBLE_STRICT_PERMISSIONS: undefined,
  } as const;
  const baseEnv = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  await withEnv(PINS, async () => {
    await spawnDeveloperContinuationChild(baseArgs(scratch("fixer-session-2b.json")), {
      spawn: baseEnv.spawn,
    });
  });
  assert(
    baseEnv.seen().env.PI_ENSEMBLE_TRUST_MODE === undefined,
    `(2) a parent that is NOT trusted and requests no stamp gives the child no trust marker — the default is not trusted (got ${String(
      baseEnv.seen().env.PI_ENSEMBLE_TRUST_MODE,
    )})`,
  );
  const stampedEnv = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  let stamped: ContinuationOutcome;
  await withEnv(PINS, async () => {
    stamped = await spawnDeveloperContinuationChild(
      { ...baseArgs(scratch("fixer-session-2c.json")), workCycleTrust: true },
      { spawn: stampedEnv.spawn },
    );
  });
  assert(
    stamped!.ok === true,
    `(2) precondition: the stamped continuation ran (${JSON.stringify(stamped!)})`,
  );
  assert(
    stampedEnv.seen().env.PI_ENSEMBLE_TRUST_MODE === "1",
    `(2) the run's stamp reaches the resumed child as PI_ENSEMBLE_TRUST_MODE=1 even under a strict parent — the same way a headless cycle's fixer is trusted (got ${String(
      stampedEnv.seen().env.PI_ENSEMBLE_TRUST_MODE,
    )})`,
  );
  assert(
    stampedEnv.seen().env.PI_ENSEMBLE_PERM_SOCKET === undefined,
    "(2) and a trust child carries no inherited broker socket — the parent's broker is not this child's",
  );
  // The strict opt-in outranks the REQUEST — the gate that keeps a lean run from being the one way
  // past PI_ENSEMBLE_STRICT_PERMISSIONS=1. Here the parent is strict by opt-in, so neither reason
  // applies and the marker stays off.
  const refused = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  await withEnv(
    { ...PINS, PI_ENSEMBLE_STRICT_PERMISSIONS: "1" },
    async () => {
      await spawnDeveloperContinuationChild(
        { ...baseArgs(scratch("fixer-session-2d.json")), workCycleTrust: true },
        { spawn: refused.spawn },
      );
    },
  );
  assert(
    refused.seen().env.PI_ENSEMBLE_TRUST_MODE === undefined,
    `(2) and the strict opt-in refuses the stamp here exactly as it does for a driver child (got ${String(
      refused.seen().env.PI_ENSEMBLE_TRUST_MODE,
    )})`,
  );
  assert(
    stampedEnv.seen().env.PI_ENSEMBLE_WRITE_ROOT === FENCE.root,
    "(2) and a stamped child is still fenced — the trust marker does not widen what it may write",
  );
}

// ── (2b) THE KILL REACHES THE GROUP, AND THE GROUP DECISION IS RECORDED ──────
//
// The fixer's dispatch sets `processGroup: true`, so its bound's SIGTERM signals the tree. A
// continuation that killed only its leader would orphan a `bash` grandchild still writing into the
// fix tree this step is about to fold and delete — and nothing else on this path reports it.
{
  const signals: string[] = [];
  const listeners: Array<(arg: unknown) => void> = [];
  const transcript = scratch("fixer-session-group.json");
  const stdout = new PassThrough();
  const proc: Record<string, unknown> = {
    stdout,
    // A real pid and NO exitCode/signalCode: the group path is taken only for a child
    // `registerChild` recorded as one, and a fake without a pid would take the leader-only path and
    // leave the assertion below passing with the group wiring deleted.
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: (sig?: string) => {
      signals.push(`leader:${String(sig)}`);
      return true;
    },
    // Neither `exit` nor `error` is EVER fired: this child HANGS, which is the only way the bound's
    // kill runs at all. The listeners are still retained (an `EventEmitter` throws an unhandled
    // `error` with none, answering `spawn-failed` and skipping the bound), and `once` exists as it
    // does on a real handle — `registerChild` arms the group reaper through it, and a handle without
    // it would silently opt out of the group policy the assertion below is about.
    on: (event: string, cb: (arg: unknown) => void) => {
      if (event === "exit" || event === "error" || event === "close") listeners.push(cb);
      return proc;
    },
    once: (event: string, cb: (arg: unknown) => void) => {
      listeners.push(cb);
      return proc;
    },
  };
  // The group path signals via `process.kill(-pid)`, which cannot reach a fake; recording it is what
  // distinguishes a group kill from a leader kill, so the call is captured rather than trusted.
  const realKill = process.kill;
  const groupSignals: string[] = [];
  (process as unknown as { kill: (p: number, s?: string) => boolean }).kill = (
    pid: number,
    sig?: string,
  ) => {
    if (pid < 0) groupSignals.push(`group:${pid}:${String(sig)}`);
    return true;
  };
  let out: ContinuationOutcome;
  try {
    out = await spawnDeveloperContinuationChild(
      { ...baseArgs(transcript), boundMs: 20 },
      { spawn: (() => proc) as never },
    );
    // The SIGKILL escalation is a grace-period timer, so give it its window before reading.
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 120));
  } finally {
    (process as unknown as { kill: typeof realKill }).kill = realKill;
  }
  assert(
    out.ok === false && out.reason === "timeout",
    `(2b) a child the bound ended answers the timeout arm (${JSON.stringify(out)})`,
  );
  assert(
    groupSignals.some((s) => s.includes("SIGTERM")) &&
      groupSignals.some((s) => s.includes("SIGKILL")),
    `(2b) the bound SIGTERMs then SIGKILLs the WHOLE GROUP through killProcessTree — the fixer's dispatch sets processGroup:true for exactly this, and a leader-only kill orphaned the bash grandchild still writing into the tree about to be folded (group ${JSON.stringify(
      groupSignals,
    )}, leader ${JSON.stringify(signals)})`,
  );
  assert(
    groupSignals.every((s) => s.includes("-4242")),
    `(2b) and the signal went to this child's own group, not a bare pid (${JSON.stringify(
      groupSignals,
    )})`,
  );
}

// ── (3) CWD — the tree, not this process's directory ──────────────────────────
{
  const transcript = scratch("fixer-session-3.json");
  const fake = child([agentEnd({ text: "done", stopReason: "end_turn" })]);
  await spawnDeveloperContinuationChild(baseArgs(transcript), { spawn: fake.spawn });
  assert(
    fake.seen().cwd === FENCE.root,
    `(3) the child started IN the fix tree — a resumed child in the parent's directory edits bytes no integration will ever read (${JSON.stringify(fake.seen().cwd)})`,
  );
}

// ── (4) THE REPLAY RULE: the last agent_end owns the reply and the cost ───────
{
  // A resumed session replays the truncated turn before answering. The two hazards are the first
  // child's closing TEXT and its 16 384-token turn, and both would be billed to the continuation.
  const replay = [
    agentEnd({
      text: "I am thinking about the approach",
      stopReason: "length",
      usage: { input: 4_000, output: 16_384, cost: 0.5 },
    }),
    agentEnd({
      text: "Fixed and committed",
      stopReason: "end_turn",
      usage: { input: 200, output: 400, cost: 0.02 },
    }),
  ];
  const raw = replay.map((e) => JSON.stringify(e)).join("\n");
  assert(
    continuationReplyText(raw).includes("Fixed and committed"),
    `(4) the reply is the LAST agent_end's (${JSON.stringify(continuationReplyText(raw))})`,
  );
  assert(
    !continuationReplyText(raw).includes("I am thinking"),
    "(4) and not the truncated turn the session replayed — reading the first child's own text back as the answer is how a wave reports a fix nobody made",
  );
  const turn = lastAgentEndFinalTurn(raw);
  assert(
    turn.stopReason === "end_turn",
    `(4) the stop reason is the last turn's, not the replayed one (${String(turn.stopReason)})`,
  );
  assert(
    turn.usage?.output === 400,
    `(4) and the tokens are that turn's OWN — summed across the replay, this child would bill 16 784 tokens it never spent (${String(turn.usage?.output)})`,
  );
  // No final assistant turn at all: the row must cost zero, not borrow a number.
  const empty = lastAgentEndFinalTurn(`${JSON.stringify({ type: "agent_end", messages: [] })}\n`);
  assert(
    empty.usage === undefined && empty.stopReason === undefined,
    `(4) a stream with no assistant turn yields NO usage rather than a guess — the absence has to stay distinguishable (${JSON.stringify(empty)})`,
  );
  // The row the step bills is built from these fields, so an outcome the child could not report has
  // to answer with the absence, and the reader must not turn it into the first child's numbers.
  const transcript = scratch("fixer-session-4.json");
  const fake = child([
    agentEnd({
      text: "done",
      stopReason: "end_turn",
      usage: { input: 10, output: 20, cost: 0.001 },
    }),
  ]);
  const out: ContinuationOutcome = await spawnDeveloperContinuationChild(baseArgs(transcript), {
    spawn: fake.spawn,
  });
  assert(
    out.ok === true && out.usage?.output === 20,
    `(4) and the outcome carries the child's own usage into the row (${JSON.stringify(out)})`,
  );
}

// ── (5) THE FAILURE ARMS, EACH NAMED ──────────────────────────────────────────
{
  const missing = join(disposables[0] ?? tmpdir(), "does-not-exist.json");
  assert(existsSync(missing) === false, "(5) precondition: the session file is absent");
  const a = await spawnDeveloperContinuationChild(baseArgs(missing), { spawn: child([]).spawn });
  assert(
    a.ok === false && a.reason === "no-session",
    `(5) a missing session file is “no-session” — no child is started in ignorance of what the first one read (${JSON.stringify(a)})`,
  );
  const c = await spawnDeveloperContinuationChild(baseArgs(scratch("fixer-session-6.json")), {
    spawn: child([{ type: "agent_end", messages: [{ role: "assistant", content: [] }] }]).spawn,
  });
  assert(
    c.ok === false && c.reason === "no-answer",
    `(5) a child that printed no reply is “no-answer”, never an empty success (${JSON.stringify(c)})`,
  );
  const d = await spawnDeveloperContinuationChild(baseArgs(scratch("fixer-session-7.json")), {
    spawn: child([agentEnd({ text: "done" })], { exitCode: 1 }).spawn,
  });
  assert(
    d.ok === true,
    `(5) a child that answered AND exited non-zero still counts its reply — the answer arrived, and a non-zero exit after a full turn is pi's own tail, not a lost fix. This is the arm most likely to be tightened into a false failure, so it is stated. (${JSON.stringify(d)})`,
  );
  const e = await spawnDeveloperContinuationChild(baseArgs(scratch("fixer-session-8.json")), {
    spawn: child([], { exitCode: null as never }).spawn,
  });
  assert(
    e.ok === false && (e.reason === "no-answer" || e.reason === "timeout"),
    `(5) a child that answered nothing is a failure with a reason, not a silent pass (${JSON.stringify(e)})`,
  );
}

// ── (6) THE BOUND never exceeds the fixer's own ceiling ───────────────────────
{
  const budget = (opts: { childBoundMs?: number }): BudgetArms => ({
    opts,
    fired: () => undefined,
  });
  assert(
    continuationBoundMs(budget({}), FIX_BOUND_MS) === FIX_BOUND_MS,
    "(6) with no armed wall clock the continuation gets the fixer's own ceiling, no more",
  );
  assert(
    continuationBoundMs(budget({ childBoundMs: 60_000 }), FIX_BOUND_MS) === 60_000,
    "(6) an armed budget may only ever TIGHTEN it — a continuation is a second child inside the same wave, not a licence for a longer turn",
  );
  assert(
    continuationBoundMs(budget({ childBoundMs: FIX_BOUND_MS * 4 }), FIX_BOUND_MS) === FIX_BOUND_MS,
    "(6) and a looser armed bound never loosens it past the fixer's ceiling",
  );
}


for (const dir of disposables) rmSync(dir, { recursive: true, force: true });
cleanupRoots();
process.exit(failures());
