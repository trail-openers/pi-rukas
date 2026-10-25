/**
 * smoke-tests/lib/park-harness — stub world for the #1743 park-memory tests.
 *
 * A temp repo with a controllable issue body, a controllable explore reply and
 * a counting ops stub, plus the two ways a park is reached: `cycle()` runs the
 * intent gate for real (so `intent-park` fires from a real verdict), and
 * `parkHandoff()` drives the handoff step for a cap explore cannot produce on
 * command — the plan gate's verdict and the branch step's open-PR pre-flight.
 *
 * The lower half (`armParkRecord`, `ctxOf`'s options, `fingerprintOf`) is what
 * the GUARD tests need rather than the cycle tests: a record written by hand,
 * and a context whose forge replies on command. `test-repeat-park-scope.ts`
 * (the guard's scope) and `test-repeat-park-projector.ts` (what a refused
 * group reports) share it, along with `assert` / `exitCode`.
 *
 * Split out of test-restart-repeat-park.ts for the §12 file-size cap; the
 * assertions live in test-restart-repeat-park.ts (forge channel + intent) and
 * test-park-memory-caps.ts (host channel + plan / open-PR parks).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../../src/forge.ts";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { runExplore } from "../../src/work-driver-explore.ts";
import { runHandoff } from "../../src/work-driver-handoff.ts";
import type { DriverHost } from "../../src/work-driver-host.ts";
import { type WorkState, appendEvent, initialState } from "../../src/workflow-state.ts";

export const ISSUE = 85;
export const URL = `https://github.com/o/r/issues/${ISSUE}#issuecomment-111`;
/** What a second ops dispatch would post — a repeat must never surface it. */
export const URL2 = `https://github.com/o/r/issues/${ISSUE}#issuecomment-222`;

export const PARK_REPLY = [
  "INTENT-VERDICT: park",
  "PARK-REASON: contradicted-by-code",
  "",
  "## Spec",
  "",
  "### Intent",
  "Reported: the retry budget is shared between infra and semantic failures.",
  "",
  "### Evidence",
  "- the counters are separate — src/step-router.ts:192 — contradicted",
  "",
  "## Rationale",
  "The issue describes behaviour that was already changed. It is stale.",
  "",
].join("\n");

export const PROCEED_REPLY = [
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

let failures = 0;
export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failures = 1;
  }
}
export function exitCode(): number {
  return failures;
}

function result(role: string, text: string): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
  } as DispatchResult;
}

/** Distinct per cycle: the record's idempotency key is the cycle's start time. */
let clock = 1_700_000_000_000;
const nextCycleAt = () => ++clock;

export interface World {
  dir: string;
  body: string;
  /** `false` → the fetch rejects (an unreachable forge). */
  bodyReadable: boolean;
  exploreReply: string;
  opsReply: string;
  /** When false, the forge's comment post throws — the failed-post park (#1743). */
  commentWorks: boolean;
  /** When false, the label never lands and its read-back reports it absent. */
  labelAddWorks: boolean;
  explores: number;
  opsPosts: number;
}

/** Overrides for the context the guard tests hand to `repeatParkVerdict`. */
export interface CtxOpts {
  /** Every issue in the group (the guard checks each). Default: the primary. */
  issues?: number[];
  /** What the stubbed `gh pr list` returns — an array of rows, or nothing. */
  prList?: unknown;
  /** The invocation that is itself the remedy for an open-PR park. */
  continuePr?: boolean;
}

export function world(label: string): World {
  const dir = mkdtempSync(path.join(tmpdir(), `repeat-park-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return {
    dir,
    body: `title:\tmock #${ISSUE}\n\nthe retry budget is shared`,
    bodyReadable: true,
    exploreReply: PARK_REPLY,
    opsReply: `posted ${URL} and labelled`,
    commentWorks: true,
    labelAddWorks: true,
    explores: 0,
    opsPosts: 0,
  };
}

/**
 * A forge whose repository is named and whose visibility is answered without a
 * lookup, so the hygiene seam's public/private question has one answer here
 * regardless of the host clone's `origin` (#1820). Only the members the handoff
 * step touches are real; the rest throw, which is what makes an unexpected call
 * visible in a failure rather than silent.
 */
function mkPrivateForge(): Forge {
  const unused = async (): Promise<never> => {
    throw new Error("park-harness forge: method not expected");
  };
  // The `needs-human-attention` label, remembered per target. The handoff VERIFIES
  // a label rather than trusting a claim (#408), so a fake that always reported the
  // label absent would make every forge post fail — and one that always reported it
  // present would make every post succeed, including the posts this harness needs
  // to see fail. State, not a constant.
  return {
    forge: "github",
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueView: async (n: number) => ({
      number: n,
      title: "t",
      body: "",
      state: "OPEN" as const,
      url: `https://github.com/acme/widget/issues/${n}`,
      author: "x",
      labels: w.labelAddWorks
        ? [{ name: "needs-human-attention", id: 1, color: "FFAA00", description: "" }]
        : [],
      createdAt: undefined,
      updatedAt: undefined,
    }),
    issueComment: async () => {
      // The forge post itself has to be able to FAIL: a park whose comment threw
      // is the case this harness counts as unreported (#1743).
      if (!w.commentWorks) throw new Error("gh: comment failed (502)");
      return URL;
    },
    issueComments: async () => [],
    labelCreate: async () => undefined,
    labelAdd: async () => {
      if (!w.labelAddWorks) throw new Error("gh: label add failed (502)");
    },
    labelRemove: async () => undefined,
    prView: async (n: number) => ({
      number: n,
      title: "t",
      body: "",
      state: "OPEN" as const,
      url: `https://github.com/acme/widget/pull/${n}`,
      headRefName: "b",
      baseRefName: "main",
      author: "x",
      mergeable: "TRUE" as const,
      labels: w.labelAddWorks
        ? [{ name: "needs-human-attention", id: 1, color: "FFAA00", description: "" }]
        : [],
      createdAt: undefined,
      updatedAt: undefined,
    }),
    prComments: unused,
    prComment: unused,
    issueCreate: unused,
    issueEdit: unused,
    issueSearch: unused,
    prList: unused,
    prCreate: unused,
    prMerge: unused,
    prDiff: unused,
    prChecks: unused,
    ciWatch: unused,
    ciRun: unused,
    mergeReadiness: unused,
    repoSettings: unused,
  };
}

export function ctxOf(w: World, opts: CtxOpts = {}): DriverContext {
  return {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: w.dir,
    // The handoff body goes through the driver hygiene seam, which asks one
    // `gh`-backed visibility question per publish (#1820). This harness is about
    // park RECORDS, not about visibility, and the answer must not depend on what
    // remote the host clone happens to carry — a clone of this very repository
    // makes the question answerable, the fold fires, and the fold can drop a term
    // the operator's private denylist still refuses, which would park the body and
    // leave the host result without one. Pin the answer: every park here posts to
    // a repository this fixture owns.
    forge: mkPrivateForge(),
    issue: ISSUE,
    issues: opts.issues ?? [ISSUE],
    // The visibility answer the hygiene seam asks for. Pinned alongside the forge
    // so the fixture's verdict never depends on whether the machine running it has
    // a `gh`, a reachable API, or an operator denylist file (#1820).
    handoffVisibility: async () => true,
    continuePr: opts.continuePr,
    issueBodyFetcherFn: async () => {
      if (!w.bodyReadable) throw new Error("gh: connection reset");
      return { stdout: w.body };
    },
    // The seam `findOpenPrForIssue` runs its `gh pr list` through — the same
    // seam the branch pre-flight uses, so the guard's re-check is the same lookup.
    verifyExecFn: async () => ({
      stdout: opts.prList === undefined ? "" : JSON.stringify(opts.prList),
    }),
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "explore") {
        w.explores++;
        return result("explore", w.exploreReply);
      }
      w.opsPosts++;
      return result("ops", w.opsReply);
    },
  };
}

/** One whole cycle as far as a park takes it: explore, then handoff on a cap. */
export async function cycle(w: World): Promise<WorkState> {
  const ctx = ctxOf(w);
  // What `--restart` yields: a fresh state, the same repoRoot.
  let state = await runExplore(ctx, initialState(ISSUE, nextCycleAt()), Date.now());
  if (state.eventLog.at(-1)?.kind === "cap-hit") {
    state = await runHandoff(ctx, state, Date.now());
  }
  return state;
}

/** A handoff for a cap the step itself cannot be coaxed into on command. */
export async function parkHandoff(
  w: World,
  cap: "plan-spec-mismatch" | "existing-pr-detected",
  extra: Partial<WorkState["pipelineState"]> = {},
  capFields: Record<string, unknown> = {},
): Promise<WorkState> {
  const withCap = appendEvent(initialState(ISSUE, nextCycleAt()), {
    kind: "cap-hit",
    at: Date.now(),
    cap,
    reviewRound: 0,
    nextStep: "handoff",
    ...capFields,
  } as never);
  return runHandoff(
    ctxOf(w),
    { ...withCap, pipelineState: { ...withCap.pipelineState, ...extra } },
    Date.now(),
  );
}

export const recordFile = (w: World, cap: string) =>
  path.join(w.dir, ".pi", "work-state", String(ISSUE), `park-${cap}.json`);
export const readRecord = (w: World, cap: string) =>
  JSON.parse(readFileSync(recordFile(w, cap), "utf8")) as Record<string, unknown>;
export const writeRecord = (w: World, cap: string, text: string) => {
  mkdirSync(path.dirname(recordFile(w, cap)), { recursive: true });
  writeFileSync(recordFile(w, cap), text, "utf8");
};

/** The same path for a GROUP SIBLING — the guard checks every issue, not just the primary. */
export const recordFileFor = (w: World, cap: string, issue: number) =>
  path.join(w.dir, ".pi", "work-state", String(issue), `park-${cap}.json`);

/** What a well-formed record carries besides the cap, as the guard reads it. */
export interface ParkRecordFields {
  reason: string;
  fingerprint: string;
  count: number;
  deliveredCount: number;
}

/**
 * Write a well-formed record for `cap` directly — for the states no real cycle
 * can be coaxed into (a malformed or expired record, a record on a sibling).
 * Timestamps are recent, so the record is live unless the caller rewrites them.
 * Returns the path so a caller can read it back or corrupt it on purpose.
 */
export function armParkRecord(
  w: World,
  cap: string,
  fields: ParkRecordFields,
  issue: number = ISSUE,
): string {
  const file = recordFileFor(w, cap, issue);
  const at = Date.now();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      cap,
      reason: fields.reason,
      fingerprint: fields.fingerprint,
      count: fields.count,
      deliveredCount: fields.deliveredCount,
      firstAt: at - 60_000,
      lastAt: at - 30_000,
      lastMarker: `<!-- pi-rukas:handoff issue=${issue} cap=${cap} -->`,
      lastCycleId: 3,
    }),
    "utf8",
  );
  return file;
}

/** The guard's own key: what `parkFingerprint` hashes the issue body into. */
export const fingerprintOf = (w: World) => createHash("sha256").update(w.body).digest("hex");

export const capOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "cap-hit" }> => e.kind === "cap-hit");
export const emittedOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "handoff-emitted" }> => e.kind === "handoff-emitted");

/** A world whose first cycle has already parked and posted its comment. */
export async function parkedWorld(label: string): Promise<World> {
  const w = world(label);
  await cycle(w);
  w.explores = 0;
  w.opsPosts = 0;
  w.opsReply = `posted ${URL2} and labelled`;
  return w;
}
