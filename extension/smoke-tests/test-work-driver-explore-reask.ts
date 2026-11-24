#!/usr/bin/env bun
/**
 * #2611 — an explore child that ends its turn on a status line gets ONE
 * same-session re-ask before the driver re-dispatches a fresh explore.
 *
 * Measured (#2610's cycle): both explore children ran to the end of their turns,
 * verified the body, said they were about to write the verdict — "Verified.
 * Writing the spec." — and emitted zero `INTENT-VERDICT:` lines. The driver
 * re-dispatched a FRESH child, which repeated the whole investigation and ended
 * the same way, and the cycle parked `explore-needs-clarification` / `cap` after
 * 465 turns and 48.8M cache-read tokens. The child that stopped on the status
 * line already holds the evidence in its own context, so the cheaper and more
 * likely move is to ask THAT session for the two things the reply contract asks
 * for, once, before paying for a stranger.
 *
 * This is the explore twin of the #2555 specify re-ask and the adversarial
 * verdict re-ask: one prompt, one line, on the child's own session file. The
 * seam is `exploreReask` on the DriverContext (the same shape the verdict
 * re-ask's `verdictReask` seam has), so the offline suite never spawns.
 *
 * What is pinned here:
 *   (1) the ask runs once, on the first reply's transcript, and its answer is
 *       routed as if the first reply had carried it;
 *   (2) the ask names the reply contract: the `INTENT-VERDICT:` line and the
 *       `## Spec` heading;
 *   (3) a child that never answers still parks exactly as today, with exactly
 *       ONE re-ask and the fresh re-dispatch that follows it;
 *   (4) a reply that already carries a verdict and a spec asks nothing at all
 *       (the byte-identical-to-today case);
 *   (5) a dispatch that FAILED is not re-asked — the provider path owns it;
 *   (6) the state records WHICH path produced the spec: first-reply,
 *       same-session re-ask, fresh re-dispatch, or artifact recovery.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import type {
  ExploreReaskFailure,
  ExploreReaskFn,
  ExploreReaskOutcome,
} from "../src/work-driver-explore-reask.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";

/** The status-line reply of the field children: it says it will write, and does not. */
const STATUS_LINE_REPLY =
  "Verified the ambient-state failures in the harness.\n\nRemaining: write the spec/verdict. Blocked: nothing.";

/** A reply the driver can route on: a verdict, a `## Spec`, one deliverable, one criterion. */
const GOOD_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Add the widget renderer.",
  "",
  "### Deliverables",
  "- D1: add the widget renderer [paths: src/widget.ts]",
  "",
  "### Acceptance criteria",
  "- the widget renders",
  "",
].join("\n");

/** What the re-ask answered with, or why it did not answer. */
type Answer = { ok: true; text: string } | { ok: false; reason: ExploreReaskFailure };

/** What the seam should report. `"unasked"` is the seam saying it was never
 * reached, which is how a test pins the no-ask path: the real child runs when
 * the context carries no seam at all, so "no seam" is not testable by omission. */
type ReaskAnswer = Answer | "unasked";

interface Drive {
  state: WorkState;
  /** The prompts the driver dispatched, in order. */
  prompts: string[];
  /** Every call the re-ask seam received, in order. */
  asks: Parameters<ExploreReaskFn>[0][];
}

/** Run `runExplore` with a scripted dispatch sequence and a scripted re-ask answer. */
async function runWith(
  label: string,
  issue: number,
  script: Array<string | Error>,
  answer: ReaskAnswer,
): Promise<Drive> {
  const dir = await mkdtemp(path.join(tmpdir(), `explore-reask-${label}-`));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const prompts: string[] = [];
    const asks: Parameters<ExploreReaskFn>[0][] = [];
    const reask: ExploreReaskFn | undefined =
      answer === "unasked"
        ? async (args) => {
            asks.push(args);
            return { ok: false, reason: "no-session", asked: false };
          }
        : async (args) => {
            asks.push(args);
            // A seam that REJECTS is a failure like any other; only an outcome is an answer.
            return answer.ok ? ({ ok: true, text: answer.text } as ExploreReaskOutcome) : answer;
          };
    const ctx: DriverContext & { emitSink: NonNullable<DriverContext["emitSink"]> } = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      emitSink: { emit: () => {}, fingerprints: [] },
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async () => ({ stdout: `title:\tmock #${issue}\n\nmock body` }),
      exploreReask: reask,
      dispatchFn: async (_pi, spec) => {
        prompts.push(spec.prompt);
        const step = script[prompts.length - 1];
        if (step === undefined) throw new Error("unscripted dispatch");
        if (step instanceof Error) throw step;
        return result(step, prompts.length);
      },
    };
    const state = await runExplore(ctx, initialState(issue, 1_000_000), 1_000_000);
    return { state, prompts, asks };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function result(text: string, n = 1): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    // The transcript the driver named for that attempt — the same path the
    // re-ask must be told to resume.
    transcriptPath: `/tmp/stub-transcript-${n}.json`,
  };
}

const reasks = (state: WorkState) =>
  state.eventLog.filter((e) => e.kind === "explore-reasked" || e.kind === "explore-retried");

// ── (1) + (2) status line, then the re-ask answers: no fresh dispatch at all ──
{
  const { state, prompts, asks } = await runWith("answers", 2611, [STATUS_LINE_REPLY], {
    ok: true,
    text: GOOD_REPLY,
  });
  assert(
    prompts.length === 1,
    `answers: no fresh re-dispatch (got ${prompts.length} dispatch${prompts.length === 1 ? "" : "es"})`,
  );
  assert(asks.length === 1, `answers: exactly one re-ask (got ${asks.length})`);
  assert(
    asks[0]?.transcriptPath === "/tmp/stub-transcript-1.json",
    `answers: the re-ask names the FIRST reply's own session (${asks[0]?.transcriptPath})`,
  );
  assert(asks[0]?.role === "explore", `answers: the re-ask resumes the explore role`);
  const prompt = asks[0]?.prompt ?? "";
  assert(
    prompt.includes("INTENT-VERDICT:"),
    "answers: the ask restates the `INTENT-VERDICT:` line the reply contract requires",
  );
  assert(prompt.includes("## Spec"), "answers: the ask restates the `## Spec` heading");
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "answers: the cycle proceeds on the re-ask's spec, as if the first reply had carried it",
  );
  assert(!state.eventLog.some((e) => e.kind === "cap-hit"), "answers: no cap-hit");
  const recorded = state.eventLog.filter((e) => e.kind === "explore-spec-source");
  assert(
    recorded.length === 1 &&
      recorded[0]?.kind === "explore-spec-source" &&
      recorded[0].source === "reask",
    `answers: the trace records the re-ask as the path that produced the spec (got ${
      recorded[0]?.kind === "explore-spec-source" ? recorded[0].source : "nothing"
    })`,
  );
  const asked = state.eventLog.find((e) => e.kind === "explore-reasked");
  assert(asked !== undefined, "answers: the ask itself is recorded in the event log");
  assert(
    asked?.kind === "explore-reasked" && asked.firstJobId === "stub-transcript-1",
    "answers: the ask event names the attempt it followed",
  );
}

// ── (3) the child never answers: exactly ONE re-ask, then today's park ────────
{
  // The scripted replies the dispatches consume, in order. A dispatch past the
  // end of the list throws, so a step that dispatched more than the case allows
  // fails the case rather than silently answering itself.
  const { state, prompts, asks } = await runWith(
    "silent",
    2612,
    [STATUS_LINE_REPLY, STATUS_LINE_REPLY],
    {
      ok: false,
      reason: "no-answer",
    },
  );
  // (3) the child never answers: exactly ONE re-ask (never a second), and the
  // fresh re-dispatch that follows it still runs.
  const asked = state.eventLog.filter((e) => e.kind === "explore-reasked");
  assert(asks.length === 1, `silent: the re-ask is issued once, never twice (got ${asks.length})`);
  assert(asked.length === 1, `silent: one re-ask recorded in the log (got ${asked.length})`);
  assert(
    prompts.length === 2,
    `silent: the fresh re-dispatch still follows (got ${prompts.length} dispatches)`,
  );
  const cap = state.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "explore-needs-clarification",
    "silent: still parks with explore-needs-clarification",
  );
  assert(
    cap?.kind === "cap-hit" &&
      cap.evidence ===
        "no verdict and no spec parsed (the same-session re-ask got no answer (no-answer); explore re-dispatched once)",
    `silent: the cap evidence names the absent verdict, the re-ask's own reason and everything the driver tried (got ${JSON.stringify(
      cap?.kind === "cap-hit" ? cap.evidence : undefined,
    )})`,
  );
  const recorded = state.eventLog.filter((e) => e.kind === "explore-spec-source");
  assert(recorded.length === 0, "silent: no spec-source row when no spec was ever produced");
}

// ── (3b) the fresh re-dispatch answers after a silent re-ask: the path is `redispatch`
{
  const { state, prompts } = await runWith("redispatch", 2613, [STATUS_LINE_REPLY, GOOD_REPLY], {
    ok: false,
    reason: "no-answer",
  });
  assert(prompts.length === 2, `redispatch: the fresh re-dispatch ran (${prompts.length})`);
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "redispatch: the cycle proceeds on the re-dispatched reply",
  );
  const recorded = state.eventLog.filter((e) => e.kind === "explore-spec-source");
  assert(
    recorded.length === 1 &&
      recorded[0]?.kind === "explore-spec-source" &&
      recorded[0].source === "redispatch",
    "redispatch: the trace records the fresh re-dispatch as the path that produced the spec",
  );
}

// ── (3b2) the re-ask ANSWERED in an unreadable form: the evidence says so ────
// The two failures the operator can act on differently, and the reason the
// lenses and the adversarial reviewer both flagged: before this, an ask whose
// child replied in prose was reported exactly like an ask that got nothing.
{
  const { state } = await runWith("unreadable", 2619, [STATUS_LINE_REPLY, STATUS_LINE_REPLY], {
    ok: true,
    text: "The spec is described above in prose, with no heading.",
  });
  const askedEvent = state.eventLog.find((e) => e.kind === "explore-reasked");
  assert(
    askedEvent?.kind === "explore-reasked" &&
      askedEvent.answered === false &&
      askedEvent.reason === "answered-without-a-readable-spec",
    `unreadable: the ask event records that the child replied and the reader refused it (got ${JSON.stringify(
      askedEvent?.kind === "explore-reasked" ? askedEvent.reason : undefined,
    )})`,
  );
  const cap = state.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" &&
      cap.evidence !== undefined &&
      cap.evidence.includes("the same-session re-ask answered but its reply held no readable spec"),
    `unreadable: the cap evidence says the ask ANSWERED, not that it got nothing (got ${JSON.stringify(
      cap?.kind === "cap-hit" ? cap.evidence : undefined,
    )})`,
  );
}

// ── (3c) the seam is never reached: no ask is CLAIMED, the re-dispatch still runs ─
{
  const { state, prompts } = await runWith(
    "noask",
    2618,
    [STATUS_LINE_REPLY, GOOD_REPLY],
    "unasked",
  );
  assert(prompts.length === 2, `no seam: the fresh re-dispatch still runs (got ${prompts.length})`);
  assert(
    !state.eventLog.some((e) => e.kind === "explore-reasked"),
    "no seam: no re-ask is recorded for an ask that never reached a child",
  );
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "no seam: the re-dispatched spec is routed — today's shape is intact",
  );
}

// ── (4) a reply that already carries a verdict and a spec: NOTHING is asked ───
{
  const { state, prompts, asks } = await runWith("good", 2614, [GOOD_REPLY], {
    ok: true,
    text: GOOD_REPLY,
  });
  assert(asks.length === 0, `good: no re-ask when the reply already carries the contract`);
  assert(prompts.length === 1, `good: one dispatch (got ${prompts.length})`);
  assert(reasks(state).length === 0, "good: neither a re-ask nor a re-dispatch is recorded");
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "good: the first reply's spec is routed",
  );
  const recorded = state.eventLog.filter((e) => e.kind === "explore-spec-source");
  assert(
    recorded.length === 1 &&
      recorded[0]?.kind === "explore-spec-source" &&
      recorded[0].source === "first-reply",
    "good: the trace records the first reply as the path that produced the spec",
  );
}

// ── (5) a dispatch that FAILED is not re-asked — the provider path owns it ────
{
  const { state, prompts, asks } = await runWith("failed", 2615, [new Error("provider timeout")], {
    ok: true,
    text: GOOD_REPLY,
  });
  assert(asks.length === 0, "failed dispatch: no re-ask on a dispatch that never completed");
  assert(prompts.length === 1, `failed dispatch: no re-dispatch (got ${prompts.length})`);
  assert(
    state.eventLog.some((e) => e.kind === "dispatch-failed"),
    "failed dispatch: dispatch-failed still recorded",
  );
  assert(
    reasks(state).length === 0,
    "failed dispatch: neither a re-ask nor a re-dispatch is recorded",
  );
}

// ── (6) a verdict with no `## Spec`, answered by the re-ask ───────────────────
{
  const verdictOnly = "INTENT-VERDICT: proceed\n\nI verified the reproduction and the fix site.";
  const { state, prompts, asks } = await runWith("verdict-only", 2616, [verdictOnly], {
    ok: true,
    text: GOOD_REPLY,
  });
  assert(asks.length === 1, `verdict-only: the missing \`## Spec\` is asked once (${asks.length})`);
  assert(prompts.length === 1, `verdict-only: no fresh dispatch (got ${prompts.length})`);
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "verdict-only: the re-ask's spec is routed",
  );
  const asked = state.eventLog.find((e) => e.kind === "explore-reasked");
  assert(
    asked?.kind === "explore-reasked" && asked.verdictParsed === true,
    "verdict-only: the ask event records that the first reply did carry a verdict",
  );
}

// ── (7) no session to resume: the ask is skipped, the re-dispatch still runs ──
{
  const dir = await mkdtemp(path.join(tmpdir(), "explore-reask-nosession-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const asks: Parameters<ExploreReaskFn>[0][] = [];
    const prompts: string[] = [];
    const ctx: DriverContext & { emitSink: NonNullable<DriverContext["emitSink"]> } = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      emitSink: { emit: () => {}, fingerprints: [] },
      repoRoot: dir,
      issue: 2617,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tmock\n\nmock body" }),
      exploreReask: async (args) => {
        asks.push(args);
        return { ok: true, text: GOOD_REPLY };
      },
      dispatchFn: async (_pi, spec) => {
        prompts.push(spec.prompt);
        const text = prompts.length === 1 ? STATUS_LINE_REPLY : GOOD_REPLY;
        return prompts.length === 1
          ? { ...result(text, 1), transcriptPath: undefined }
          : result(text, 2);
      },
    };
    const state = await runExplore(ctx, initialState(2617, 1_000_000), 1_000_000);
    assert(asks.length === 0, "no transcript: nothing is asked of a session that cannot be named");
    assert(
      prompts.length === 2,
      `no transcript: the fresh re-dispatch still runs (got ${prompts.length})`,
    );
    assert(
      state.pipelineState.normalisedSpec?.verdict === "proceed",
      "no transcript: the re-dispatched spec is routed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
