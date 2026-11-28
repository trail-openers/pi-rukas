#!/usr/bin/env bun
/**
 * #2618 end to end at the step: a child that submits its tests only from inside
 * a codemode script is credited by the lean steps.
 *
 * The bug is a step-level bug — the specify step read the child as silent,
 * nudged it, and re-dispatched a FRESH author on a base-reset tree, losing the
 * first attempt's files — so it is pinned at the step, not only at the collapse.
 * Each case builds the child's transcript in Pi's shapes (assistant toolCall
 * blocks plus the parent `toolResult` carrying its `nestedCalls` rows), runs it
 * through the real `collapseEvents`, and hands the resulting `DispatchResult` to
 * the real step through the shared fixtures. Nothing under `src/lean` is stubbed.
 *
 *   (1) specify: a child whose ONLY submissions are nested -> `ok`, ONE dispatch,
 *       no submit nudge in any prompt, and the attempt never read as silent;
 *   (1b) the mirror: a codemode call that made no submission still gets the
 *       retry and the nudge — the credit is not a shortcut past a silent child;
 *   (2) the challenge step's own reader (`extractSubmitTests`) reads a nested
 *       round's submission, which is the half of `challenge` the fixture can
 *       reach (it has no dispatch-result hook);
 *   (3) build: a nested `report_blocked` is honoured by the anti-forgery gate
 *       exactly as a direct one is, and a nested-only child is not `didNoWork`.
 *
 * The AC5 half — the fix touches no file under `extension/src/lean` — is pinned
 * at the bottom, where such a fix would have landed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { didNoWork } from "../src/lean/build-dispatch.ts";
import { extractSubmitTests } from "../src/lean/submit-tests-extract.ts";
import {
  blockedArgs,
  codemodeResult,
  codemodeTurn,
  nestedOk,
  submitArgs,
} from "./fixtures/nested-call-events.ts";
import { ROOTS as BUILD_ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { collapsedChild } from "./lib/lean-nested-submit.ts";
import { ROOTS, makeRepo, redScript, runSpecify } from "./lib/lean-specify-fixture.ts";
import {
  CONFIG,
  NUDGE,
  report as reportShared,
  writeTest,
} from "./lib/lean-specify-reprompt-constants.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The transcript of a child that submitted one criterion from inside codemode. */
function nestedSubmitTurn(criterionId: string, rel: string) {
  return {
    messages: [
      codemodeTurn("call-codemode-1"),
      codemodeResult("call-codemode-1", [
        nestedOk("call-codemode-1/1", "submit_tests", submitArgs(criterionId, [rel])),
      ]),
    ],
  };
}

/** A repo whose base holds an implementation the fixture's test is red against. */
async function repo(): Promise<{ repoRoot: string; baseSha: string }> {
  return makeRepo({ "src/retry.ts": "export const retry = () => { throw new Error('x'); };\n" });
}

// ── (1) specify: a nested-only submitter is credited, and not re-dispatched ──
{
  const prompts: string[] = [];
  const { repoRoot, baseSha } = await repo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2618,
    config: CONFIG,
    prompts,
    writes: (wt) => writeTest(wt, redScript()),
    // The step reads whatever the collapse produced, so the case supplies the
    // transcript and the helper supplies the collapse. `toolUses: []` keeps the
    // fixture's own field from overwriting the collapsed one.
    toolUses: [],
    dispatchResults: () =>
      collapsedChild("developer", nestedSubmitTurn("AC1", "tests/AC1-retry.test.sh")),
  });
  reportShared(r, "(1)", assert);
  assert(
    r.outcome?.kind === "ok",
    `(1) the step freezes the nested submission (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.dispatched === 1, `(1) and dispatches ONE author (got ${r.dispatched})`);
  assert(
    prompts.length === 1 && prompts[0]?.includes(NUDGE) !== true,
    `(1) with no submit nudge in any prompt (got ${prompts.length} prompt(s))`,
  );
  // The silence predicate's inputs, read off the outcome the step recorded: an
  // `ok` freeze is the arm a silent attempt can never reach (silence is only
  // computed when nothing was kept), so it says the attempt was not silent
  // without reaching past the fixture's seams.
  assert(
    r.outcome?.kind === "ok",
    `(1) so the attempt was judged as a submitting one, not a silent one (got ${r.outcome?.kind})`,
  );
}

// ── (1b) the mirror: a child that submitted nothing at all still retries ─────
{
  const prompts: string[] = [];
  const { repoRoot, baseSha } = await repo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2619,
    config: CONFIG,
    prompts,
    writes: (wt) => writeTest(wt, redScript()),
    toolUses: [],
    // A codemode call that made no submit_tests row at all: crediting the nested
    // channel must not turn a silent child into a submitting one.
    dispatchResults: () =>
      collapsedChild("developer", {
        messages: [
          codemodeTurn("call-codemode-1"),
          codemodeResult("call-codemode-1", [
            nestedOk("call-codemode-1/1", "read", { path: "src/retry.ts" }),
          ]),
        ],
      }),
  });
  reportShared(r, "(1b)", assert);
  assert(
    r.dispatched === 2,
    `(1b) a child that made no submission still gets the one retry (got ${r.dispatched})`,
  );
  assert(prompts[1]?.includes(NUDGE) === true, "(1b) and the retry still carries the nudge");
}

// ── (2) the challenge step's reader sees a nested round ──────────────────────
{
  // `challenge` reads `read.result.toolUses` and hands it to the SAME extractor
  // specify does (`challenge.ts` -> `runTestPipeline` -> `extractSubmitTests`).
  // Its fixture has no dispatch-result hook, so the case pins the two production
  // halves in the order the step uses them rather than inventing a seam in src.
  const child = collapsedChild(
    "adversarial-developer",
    nestedSubmitTurn("AC1", "tests/AC1-edge.test.sh"),
  );
  const read = extractSubmitTests(child.toolUses);
  assert(
    read.rows.length === 1 && read.rows[0]?.criterionId === "AC1" && read.skipped === 0,
    `(2) the extractor the challenge step calls reads a nested round's submission (got ${JSON.stringify(read)})`,
  );
}

// ── (3) build: a nested blocked report is honoured ───────────────────────────
{
  const CONFLICT = "case 2 needs the array mutable while case 3 mutates it in place";
  const r = await runBuild({
    issue: 2621,
    toolUses: [],
    dispatchResults: () =>
      collapsedChild("developer", {
        messages: [
          codemodeTurn("call-codemode-1"),
          codemodeResult("call-codemode-1", [
            nestedOk(
              "call-codemode-1/1",
              "report_blocked",
              blockedArgs([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
            ),
          ]),
        ],
      }),
  });
  assert(r.threw === undefined, `(3) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "blocked",
    `(3) the nested blocked report is honoured (got ${r.outcome?.kind ?? "none"})`,
  );
  assert(
    r.outcome?.blockedBy?.["tests/AC1-retry.test.sh"] === CONFLICT,
    `(3) and records the child's reason (got ${JSON.stringify(r.outcome?.blockedBy)})`,
  );
}

// ── (3b) a build child whose only calls were nested did work ─────────────────
{
  const child = collapsedChild("developer", nestedSubmitTurn("AC1", "tests/AC1.test.sh"), {
    ok: false,
    exitCode: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  });
  assert(
    didNoWork(child) === false,
    "(3b) a child whose only calls were nested is not read as having done no work",
  );
  const idle = collapsedChild(
    "developer",
    { messages: [] },
    {
      ok: false,
      exitCode: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    },
  );
  assert(
    didNoWork(idle) === true,
    "(3b) while a child that made no call at all still is (the credit is not a free pass)",
  );
}

// ── (3c) the direct channel is untouched ─────────────────────────────────────
{
  const CONFLICT = "the two frozen assertions contradict each other";
  const r = await runBuild({
    issue: 2622,
    // The frozen file stays red, so the anti-forgery gate honours either report.
    toolUses: [
      {
        name: "report_blocked",
        arguments: blockedArgs([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
      },
    ],
  });
  assert(
    r.outcome?.kind === "blocked",
    `(3c) a directly issued report still reaches the same verdict (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
}

// ── (4) AC5: the fix lives OUTSIDE the lean engine ──────────────────────────
{
  // Placing the read in the transport is what keeps the lean engine's cap and its
  // reviewers untouched. A fix that landed under `src/lean/` would fail here.
  const transport = path.join(import.meta.dirname, "..", "src", "spawn-collapse-events.ts");
  const src = existsSync(transport) ? readFileSync(transport, "utf8") : "";
  assert(
    src.includes("nestedCalls"),
    "(4) the nested read lives in the transport, not under extension/src/lean",
  );
  const leanDir = path.join(import.meta.dirname, "..", "src", "lean");
  assert(existsSync(leanDir), "(4) and the lean engine directory is where it always was");
}

void ROOTS;
void BUILD_ROOTS;

process.exit(exit);
