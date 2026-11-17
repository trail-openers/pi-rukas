/**
 * Fixtures for the adversarial verdict re-ask suite — the fenced reviewer
 * replies and the stubbed dispatch behind them, shared by the two test files
 * the suite is split across (AGENTS.md §12 size cap: the loop-side cases and
 * the child-side cases are different subjects that happen to need the same
 * broken review).
 *
 * The shapes are built by ONE generator so a fixture that drifts from "99
 * lines, fence opens at 4, closes on the last line" is visible in the
 * construction rather than buried in a string, and each case is checked against
 * the reader's own candidate rule (`reaskShapesAreFenced`) before it is used:
 * a fixture that quietly became readable would fail there, not make every
 * assertion downstream vacuously pass.
 */

import { mock } from "bun:test";
import { verdictCandidateLines } from "../../src/adversarial-verdict-read.ts";
import type { DispatchResult } from "../../src/types.ts";
import { isolateLedger } from "./review-ledger-test-helpers.ts";

export const BACKTICK = String.fromCharCode(0x60);
export const FENCE = BACKTICK.repeat(3);

export const DIFF = "diff --git a/a.ts b/a.ts\n+export const draw = () => 1;\n";
/** The session path the stubbed reviewer reports for its own dispatch — the file
 * the re-ask must be pointed at, and the one the round must keep. */
export const TRANSCRIPT = "/tmp/pi-rukas-dev-fv/review-session.json";
/** The model the stubbed reviewer reports — the round's model, which a re-ask
 * must not re-point. */
export const REVIEWER_MODEL = "reviewer-model-1";
/** The reviewer's own spend, and the re-ask child's. Distinct numbers so a fold
 * that skipped the re-ask, or re-pointed the round at it, shows up in a total. */
export const REVIEWER_USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.1,
  turns: 2,
};
export const REASK_USAGE = {
  input: 7,
  output: 3,
  cacheRead: 1,
  cacheWrite: 0,
  cost: 0.05,
  turns: 1,
};

export interface Shape {
  name: string;
  /** The short key (`a`–`d`) the off-arm goldens are keyed by. Part of the shape
   * so a key cannot drift from the shape it names. */
  key: string;
  lines: string[];
  verdict: string;
}

/** A fenced report: prose, a fence that opens at `open`, the verdict line,
 * finding lines, and a fence that closes at `close` (inclusive, 1-based). */
export function fencedReport(opts: {
  total: number;
  open: number;
  close: number;
  verdictAt: number;
  verdict: string;
}): string[] {
  return Array.from({ length: opts.total }, (_u, i) => {
    const n = i + 1;
    if (n === opts.open || n === opts.close) return FENCE;
    if (n === 1) return "Review report:";
    if (n === 2) return "";
    if (n === opts.verdictAt) return `VERDICT: ${opts.verdict}`;
    if (n > opts.open && n < opts.close) {
      return `${String(n - opts.open - 1)}. finding at line ${String(n)} — silent failure on the bound path`;
    }
    return `prose line ${String(n)}`;
  });
}

export const SHAPES: Shape[] = [
  {
    key: "a",
    name: "(a) 99 lines, fence opens at 4 and closes on the last line",
    lines: fencedReport({ total: 99, open: 4, close: 99, verdictAt: 5, verdict: "ISSUES_FOUND" }),
    verdict: "ISSUES_FOUND",
  },
  {
    key: "b",
    name: "(b) 70 lines, fence 4–70",
    lines: fencedReport({
      total: 70,
      open: 4,
      close: 70,
      verdictAt: 5,
      verdict: "CRITICAL_ISSUES_FOUND",
    }),
    verdict: "CRITICAL_ISSUES_FOUND",
  },
  {
    key: "c",
    name: "(c) 44 lines, fence 9–43",
    lines: fencedReport({
      total: 44,
      open: 9,
      close: 43,
      verdictAt: 10,
      verdict: "MINOR_OBSERVATIONS",
    }),
    verdict: "MINOR_OBSERVATIONS",
  },
  {
    key: "d",
    name: "(d) the short repro: report, blank, fence, verdict, two findings, close",
    lines: [
      "Review report:",
      "",
      FENCE,
      "VERDICT: MINOR_OBSERVATIONS",
      "1. the bound is read at the wrong time",
      "2. the ledger row is written before the round completes",
      FENCE,
    ],
    verdict: "MINOR_OBSERVATIONS",
  },
];

/** Every VERDICT candidate in every shape must be fenced — pinned against the
 * reader's OWN rule, so a fixture that stopped being unreadable fails here. */
export function reaskShapesAreFenced(assert: (cond: boolean, msg: string) => void): void {
  for (const shape of SHAPES) {
    const candidates = verdictCandidateLines(shape.lines.join("\n"));
    assert(
      candidates.length > 0 && candidates.every((c) => c.fenced),
      `(0) ${shape.name}: every VERDICT candidate is fenced — the reader refuses it by design`,
    );
  }
}

// ── the child stub ───────────────────────────────────────────────────────────
let reviewerReply = "";
let reviewerTranscript: string | undefined = TRANSCRIPT;
/** The transcript the NEXT dispatch reports — the empty string is the case the
 * loop must refuse: a reviewer whose child left no session file to ask. */
let nextTranscript: string | undefined | null = null;
/** The session path the NEXT reviewer dispatch reports. `""` is the no-session case:
 * a reviewer whose child wrote no transcript, whose round must therefore keep
 * the infrastructure failure it had. */
export function setNextTranscript(value: string | undefined): void {
  nextTranscript = value;
}
/** The replies still queued for the reviewer's SECOND dispatch (a fix round's
 * review); the queue's head is consumed and an empty queue repeats the last. */
let reviewerQueue: string[] = [];
/** Every dispatch the loop made, so a case can count the asks a round caused
 * instead of inferring them from behaviour. */
export const dispatches: Array<{ role: string; text: string }> = [];

mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-fenced-reask",
  spawnSpecialist: async (spec: { role: string; prompt: string }) => {
    const isReviewer = spec.role === "adversarial-developer";
    const text = isReviewer ? (reviewerQueue.shift() ?? reviewerReply) : "addressed the findings";
    dispatches.push({ role: spec.role, text });
    return {
      role: spec.role,
      ok: true,
      text,
      toolUses: [],
      ms: 1,
      exitCode: 0,
      usage: { ...REVIEWER_USAGE },
      ...(nextTranscript === null
        ? reviewerTranscript === undefined
          ? {}
          : { transcriptPath: reviewerTranscript }
        : { transcriptPath: nextTranscript }),
      model: REVIEWER_MODEL,
    } as DispatchResult;
  },
}));

const deck = await import("../../src/dispatch-deck.ts");
mock.module(new URL("../../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...deck,
  startEntry: () => {},
  updateEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));
const registry = await import("../../src/async-jobs-registry.ts");
mock.module(new URL("../../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...registry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

/** Arm the stub for one reviewer reply (and the optional later ones a fix round
 * will need), and reset the dispatch log. */
export function armReviewer(opts: {
  reply: string;
  queue?: string[];
  /** The session path the reviewer's result carries; see `setNextTranscript`
   * for the no-session case. */
  transcript?: string;
}): void {
  dispatches.length = 0;
  reviewerReply = opts.reply;
  reviewerQueue = opts.queue ?? [];
  reviewerTranscript = opts.transcript === undefined ? TRANSCRIPT : opts.transcript;
  nextTranscript = opts.transcript === undefined ? null : opts.transcript;
}

/** Point the ledger at a temp file for the run — these tests live in a worktree
 * of the real clone and must not write its ledger. */
export { isolateLedger };
