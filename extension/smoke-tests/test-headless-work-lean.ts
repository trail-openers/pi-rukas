#!/usr/bin/env bun
/**
 * epic #1883 — `pi-rukas-headless work-lean <issue>`: the verb drives the lean
 * engine through an injected `run` and maps its answer to the exit code and the
 * one JSON document, without a model call, a git call or a forge.
 *
 *   code 10 / handed-back → 10, one document, state and steps
 *   code 0 / 11           → 0 / 11 (the engine's own codes pass through)
 *   a held lock           → 40, error.code "refused"
 *   any other throw       → 30, error.code "crash"
 *   bad argv              → 40, error.code "bad-arguments", nothing ran
 *   a publish step        → doc.prUrl is the newest publish step's URL
 *   headless children     → the lean dispatch seam stamps workCycleTrust
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import { isLeanHeadless, leanChildOpts, markLeanHeadless } from "../src/lean/child-opts.ts";
import { runWorkLean } from "../src/lean/command.ts";
import type { RunLeanResult } from "../src/lean/engine.ts";
import { acquireLock } from "../src/lean/lock.ts";
import type { LeanState } from "../src/lean/state.ts";
import { LeanStateError } from "../src/lean/state.ts";
import type { Step } from "../src/lean/state.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();

/** A run whose step log is `steps` and whose stamp is `code`/`state`. */
function fakeRun(overrides: {
  code: number;
  state: LeanState;
  reason?: string;
  steps?: Step[];
}): RunLeanResult {
  return {
    code: overrides.code,
    state: overrides.state,
    run: {
      schema: 1,
      issue: 7,
      version: "0.0.0-test",
      models: {},
      baseSha: "feedbeef1234567890feedbeef1234567890abcd",
      branch: "feature/issue-7-thing",
      state: overrides.state,
      counters: {
        buildAttempts: 1,
        challengeDone: true,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: overrides.steps ?? [],
      result: { code: overrides.code, reason: overrides.reason ?? "because" },
    },
  };
}

function step(state_: Step["state"], outcome: Step["outcome"] = { kind: "ok" }): Step {
  return { key: `7:${state_}:0`, state: state_, startedAt: 1, endedAt: 2, outcome };
}

const REPO = "/tmp/pi-rukas-work-lean-verb";
const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Run the verb with an injected `run`, checking the shared output contract. */
async function verb(
  argv: string[],
  run: () => Promise<{ summary: string; result: RunLeanResult }>,
) {
  return runVerb("work-lean", argv, REPO, (_argv, ctx) =>
    runWorkLeanVerb(argv, ctx, async () => run()),
  );
}

// ── (a) a handed-back run: exit 10, one document, the state, ≥1 NDJSON line.
{
  const r = await verb(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10) — handler error at build",
    result: fakeRun({ code: 10, state: "handed-back", steps: [step("ready"), step("build")] }),
  }));
  assert(r.violations.length === 0, `handed-back: output contract (${r.violations.join("; ")})`);
  assert(r.code === 10, `handed-back exits 10 (got ${r.code})`);
  assert(r.doc.subcommand === "work-lean", "document names the subcommand");
  assert(r.doc.issue === 7, "document carries the issue");
  assert(r.doc.state === "handed-back", `document carries the state (got ${r.doc.state})`);
  assert(r.doc.exitCode === 10, "document's exitCode matches");
  assert(r.doc.steps === 2, `document counts the steps (got ${r.doc.steps})`);
  assert(
    typeof r.doc.summary === "string" && (r.doc.summary as string).includes("handed-back"),
    "document carries the summary",
  );
  assert(r.doc.prUrl === undefined, "no publish step means no prUrl");
  assert(r.lines.length >= 1, `at least one NDJSON line (${r.lines.length})`);
  assert(
    r.lines.some((l) => l.kind === "log" && String(l.message).includes("work-lean: #7 starting")),
    "a starting progress line was emitted",
  );
  assert(
    r.lines.some((l) => l.kind === "log" && String(l.message).includes("handed-back (exit 10)")),
    "the final progress line carries the summary",
  );
}

// ── (b) the engine's own codes pass through.
for (const [code, state_] of [
  [0, "landed"],
  [11, "not-ready"],
] as const) {
  const r = await verb(["7"], async () => ({
    summary: `work-lean #7: ${state_} (exit ${code})`,
    result: fakeRun({ code, state: state_ as LeanState }),
  }));
  assert(r.code === code, `state ${state_} exits ${code} (got ${r.code})`);
  assert(r.doc.exitCode === code, `document's exitCode is ${code}`);
  assert(r.doc.state === state_, `document's state is ${state_}`);
}

// ── (c) a held lock is a refusal, not a crash.
{
  const r = await verb(["7"], async () => {
    throw new LeanStateError("run already in progress (host 1 2 3) for issue 7");
  });
  assert(r.violations.length === 0, `held lock: output contract (${r.violations.join("; ")})`);
  assert(r.code === 40, `a held lock exits 40 (got ${r.code})`);
  assert((r.doc.error as { code?: string })?.code === "refused", "refused: error.code");
  assert(
    String((r.doc.error as { message?: string })?.message).includes("already in progress"),
    "refused: the lock's own message is kept",
  );
  // A lock error raised as a plain Error but carrying lock.ts's wording is the
  // same fact, and must not be reported as a crash.
  const plain = await verb(["7"], async () => {
    throw new Error("lock unreadable: /x/.pi/lean-state/7.json.lock");
  });
  assert(plain.code === 40, `a wording-only lock error still exits 40 (got ${plain.code})`);
  assert(
    (plain.doc.error as { code?: string })?.code === "refused",
    "wording-only lock error is still refused",
  );
}

// ── (d) any other throw is a crash, and the verb never lets one escape.
{
  const r = await verb(["7"], async () => {
    throw new Error("git exploded");
  });
  assert(r.violations.length === 0, `crash: output contract (${r.violations.join("; ")})`);
  assert(r.code === 30, `a throwing run exits 30 (got ${r.code})`);
  assert((r.doc.error as { code?: string })?.code === "crash", "crash: error.code");
  assert(
    String((r.doc.error as { message?: string })?.message).includes("git exploded"),
    "crash: the message is kept",
  );
  assert(r.doc.state === undefined, "a crash reports no state");
}

// ── (e) bad argv: no issue, a non-numeric issue, an extra flag, two issues.
for (const argv of [[], ["abc"], ["--bogus"], ["7", "8"], ["7", "--force"]]) {
  let ran = false;
  const r = await verb(argv, async () => {
    ran = true;
    return { summary: "should not run", result: fakeRun({ code: 0, state: "landed" }) };
  });
  assert(r.code === 40, `argv ${JSON.stringify(argv)} exits 40 (got ${r.code})`);
  assert(
    (r.doc.error as { code?: string })?.code === "bad-arguments",
    `argv ${JSON.stringify(argv)}: error.code bad-arguments`,
  );
  assert(!ran, `argv ${JSON.stringify(argv)}: the engine never ran`);
}
{
  const r = await verb(["0"], async () => ({
    summary: "s",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 40, `issue 0 is refused (got ${r.code})`);
}
{
  // --json is accepted and changes nothing.
  const r = await verb(["7", "--json"], async () => ({
    summary: "work-lean #7: landed (exit 0)",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 0 && r.doc.state === "landed", "--json is accepted");
}

// ── (f) the newest publish step's URL is reported.
{
  const r = await verb(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10)",
    result: fakeRun({
      code: 10,
      state: "handed-back",
      steps: [
        step("publish", { kind: "ok", prUrl: "https://example.test/pull/1" }),
        step("ci", { kind: "red" }),
        step("publish", { kind: "ok", prUrl: "https://example.test/pull/2" }),
      ],
    }),
  }));
  assert(
    r.doc.prUrl === "https://example.test/pull/2",
    `doc.prUrl is the newest publish URL (got ${r.doc.prUrl})`,
  );
}

// ── (g) a headless lean run's children carry the /work-cycle trust stamp.
{
  const headless = leanChildOpts({ headless: true });
  assert(headless.workCycleTrust === true, "a headless lean dispatch carries workCycleTrust: true");
  const interactive = leanChildOpts({ headless: false });
  assert(interactive.workCycleTrust === false, "an interactive lean run's children carry no stamp");
  assert(Object.keys(interactive).length === 1, "the stamp is the only field it adds");

  // The three lean dispatch sites stamp themselves from the process, so the
  // verb marking the process is the whole mechanism. An interactive `/work-lean`
  // never calls `markLeanHeadless`, so it stays exactly as it was; the verb
  // does, and the stamp then reaches a dispatch's options.
  markLeanHeadless();
  assert(isLeanHeadless() === true, "the headless verb marks the process headless");
  const seen: Record<string, unknown>[] = [];
  const fakeSpawn = async (_spec: unknown, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { role: "developer", ok: true, text: "", toolUses: [], ms: 1, exitCode: 0 };
  };
  await fakeSpawn(
    { role: "developer", prompt: "p" },
    {
      writeFence: undefined,
      extraArgs: undefined,
      ...leanChildOpts(),
    },
  );
  assert(
    seen[0]?.workCycleTrust === true,
    "the dispatch seam spreads the stamp after its own opts",
  );
  // The three sites each read the process flag through the same helper, so a
  // site that forgot to spread it is caught by the static audit below.
  const src = readFileSync(path.join(SRC, "lean", "build.ts"), "utf8");
  assert(
    /\.\.\.leanChildOpts\(\)/.test(src) &&
      /\.\.\.leanChildOpts\(\)/.test(
        readFileSync(path.join(SRC, "lean", "challenge.ts"), "utf8"),
      ) &&
      /\.\.\.leanChildOpts\(\)/.test(readFileSync(path.join(SRC, "lean", "command.ts"), "utf8")),
    "all three lean dispatch sites spread leanChildOpts()",
  );

  // And the refusal the real engine produces: a live run holds this issue's
  // lock, so the verb reports 40/refused and not 30/crash.
  const repo = await mkdtemp(path.join(os.tmpdir(), "work-lean-lock-"));
  const holder = acquireLock(repo, 7);
  const locked = await runVerb("work-lean", ["7"], repo, (argv, ctx) =>
    runWorkLeanVerb(argv, ctx, (root, issue) => runWorkLean(root, issue)),
  );
  assert(locked.code === 40, `a held lock refuses the real engine at 40 (got ${locked.code})`);
  assert(
    (locked.doc.error as { code?: string })?.code === "refused",
    "the real lock refusal is reported as refused",
  );
  holder();
  await rm(repo, { recursive: true, force: true });

  // A non-Error throw must not escape as a rejection either.
  const r = await verb(["7"], async () => {
    throw "string thrown";
  });
  assert(r.code === 30, `a non-Error throw still exits 30 (got ${r.code})`);
  assert(
    String((r.doc.error as { message?: string })?.message).includes("string thrown"),
    "a non-Error throw still reports its text",
  );
}

process.exit(state.exit);
