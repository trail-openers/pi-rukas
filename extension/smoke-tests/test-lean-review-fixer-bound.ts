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
 *   (5) the failure arms, each with its own reason: no session file, a role with no prompt file, a
 *       child that printed nothing, a child the bound ended — and the one that must NOT be a pass, a
 *       child that exited non-zero
 *   (6) the bound handed to the child never exceeds the fixer's own ceiling
 *
 * The child is spawned through the injected `spawn` seam, so nothing here starts a pi, spends a token,
 * or reads a model's output.
 */

import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ContinuationOutcome,
  continuationChildArgs,
  continuationReplyText,
  lastAgentEndFinalTurn,
  spawnDeveloperContinuationChild,
} from "../src/developer-session-continuation.ts";
import { continuationBoundMs } from "../src/fixer-truncation.ts";
import { FIX_BOUND_MS } from "../src/lean/review.ts";
import type { BudgetArms } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const ROOTS: string[] = [];
const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "lean-continuation-"));
  ROOTS.push(dir);
  const file = join(dir, name);
  writeFileSync(file, '{"type":"user","message":"the fixer read this"}\n');
  return file;
};

/** The fence and tree one case hands the child. */
const FENCE = {
  root: "/run/.worktrees/lean-7-fix-a-full-0-1700000000000",
  repo: "/run",
  scratch: "/run/tmp/issue-7",
} as const;

/** A child that answers one `agent_end` and exits 0. */
function child(
  events: unknown[],
  opts: {
    exitCode?: number;
    onSpawn?: (argv: string[], env: Record<string, string | undefined>, cwd?: string) => void;
  } = {},
): {
  spawn: typeof spawn;
  seen: () => { argv: string[]; env: Record<string, string | undefined>; cwd?: string };
} {
  let seen: { argv: string[]; env: Record<string, string | undefined>; cwd?: string } = {
    argv: [],
    env: {},
  };
  return {
    seen: () => seen,
    spawn: ((
      _cmd: string,
      argv: string[],
      o?: { env?: Record<string, string | undefined>; cwd?: string },
    ) => {
      seen = { argv, env: o?.env ?? {}, cwd: o?.cwd };
      opts.onSpawn?.(argv, o?.env ?? {}, o?.cwd);
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      queueMicrotask(() => {
        for (const e of events)
          (stdout as unknown as { write: (s: string) => void }).write(`${JSON.stringify(e)}\n`);
        (stdout as unknown as { end: () => void }).end();
      });
      // The child reads its one prompt and then goes; `end()` on the caller's side is what lets it exit.
      stdin.on("data", () => undefined);
      const proc = {
        stdout,
        stderr: new PassThrough(),
        stdin,
        kill: () => true,
        on: (event: string, cb: (arg: never) => void) => {
          if (event === "exit") queueMicrotask(() => cb((opts.exitCode ?? 0) as never));
          return proc;
        },
      } as unknown as ChildProcessWithoutNullStreams;
      return proc;
    }) as typeof spawn,
  };
}

const agentEnd = (over: {
  text?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
}): unknown => ({
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      ...(over.stopReason === undefined ? {} : { stopReason: over.stopReason }),
      content: [{ type: "text", text: over.text ?? "" }],
      ...(over.usage === undefined ? {} : { usage: over.usage }),
    },
  ],
});

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
    promptFile: "/tmp/p.md",
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
  const missing = join(ROOTS[0] ?? tmpdir(), "does-not-exist.json");
  assert(existsSync(missing) === false, "(5) precondition: the session file is absent");
  const a = await spawnDeveloperContinuationChild(baseArgs(missing), { spawn: child([]).spawn });
  assert(
    a.ok === false && a.reason === "no-session",
    `(5) a missing session file is “no-session” — no child is started in ignorance of what the first one read (${JSON.stringify(a)})`,
  );
  const b = await spawnDeveloperContinuationChild(
    { ...baseArgs(scratch("fixer-session-5.json")), role: "not-a-role" },
    { spawn: child([]).spawn },
  );
  assert(
    b.ok === false && b.reason === "no-role",
    `(5) a role with no prompt file is “no-role” (${JSON.stringify(b)})`,
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

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(failures());
