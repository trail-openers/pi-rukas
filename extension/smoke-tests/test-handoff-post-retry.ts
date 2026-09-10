#!/usr/bin/env bun
/**
 * #674 item 3 — retry-with-backoff for the handoff's in-process forge post.
 *
 * `runHandoff`'s in-process fallback (the path that fires when the ops
 * dispatch fails or the comment URL didn't parse) used to make a SINGLE
 * shot at `forge.issueComment` + `forge.labelCreate` + `forge.labelAdd`.
 * A transient API hiccup (429, 5xx, network blip) on that first attempt
 * immediately became a manual-recovery task: the handoff-emitted event
 * recorded commentUrl=undefined/labelApplied=false and the in-chat
 * "HANDOFF DISPATCH INCOMPLETE" banner with manual `gh` commands was
 * printed. #659/#660 both hit exactly this shape on their first handoff
 * attempt.
 *
 * `work-driver-handoff-post-retry.ts` now retries the failed call with a
 * jittered linear backoff (bounded to 3 attempts total, escape hatch
 * `PI_ENSEMBLE_HANDOFF_POST_RETRY=0`), following the same shape as
 * `dispatch-retry.ts` / `work-driver-failure-taxonomy.ts`.
 *
 * This test drives `runHandoff` with a failing `dispatchFn` (so the
 * in-process path is always taken) and an injected flaky Forge (the
 * `ctx.forge` seam — no network), and asserts:
 *
 *   1. Flaky forge (issueComment fails once, succeeds on retry) → the
 *      handoff-emitted event carries the SECOND attempt's URL, label
 *      applied, NO INCOMPLETE banner surface (the rendered in-chat
 *      message contains no "HANDOFF DISPATCH INCOMPLETE" line).
 *   2. Flaky label (comment ok, labelAdd fails once) → commentUrl
 *      preserved, label retried + applied, single handoff-emitted event.
 *   3. Hard-fail forge (every call throws) → all 3 attempts consumed,
 *      handoff-emitted records commentUrl=undefined + labelApplied=false,
 *      and the rendered in-chat message DOES carry the INCOMPLETE banner
 *      with the verbatim manual `gh` commands.
 *   4. Invariant — a healthy dispatch (URL + label from the ops reply)
 *      does NOT trigger the forge's issueComment (the retry loop must
 *      not run when there is nothing to post).
 *   5. Idempotency pin — the retry-then-success path emits exactly ONE
 *      handoff-emitted event (no duplicate event, matching the re-entry
 *      dedupe's "newest event wins" contract).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import {
  handoffPostRetryEnabled,
  postHandoffWithRetry,
} from "../src/work-driver-handoff-post-retry.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakePi = {
  sendUserMessage: () => undefined,
} as unknown as ExtensionAPI;

/** A failing dispatch that never returns a URL or label — forces the in-process path. */
function failingDispatch(): DriverContext["dispatchFn"] {
  return async (_pi: ExtensionAPI, _spec, _opts): Promise<DispatchResult> => {
    throw new Error("ops dispatch failed (simulated)");
  };
}

type Call = { method: string; args: unknown[] };

/**
 * A fake Forge whose failure behaviour is scripted per method:
 * `failures: Record<method, number[]>` — the first N calls to that method
 * throw (with the given error text); subsequent calls succeed.
 */
function mkFlakyForge(script: {
  issueCommentFailures?: number[];
  labelAddFailures?: number[];
  labelCreateFailures?: number[];
}) {
  const calls: Call[] = [];
  const counters: Record<string, number> = {};
  const failNext = (method: string, scriptArr: number[]) => {
    const n = (counters[method] ?? 0) + 1;
    counters[method] = n;
    return n <= (scriptArr?.length ?? 0);
  };
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueComment: async (n: number, body: string) => {
      calls.push({ method: "issueComment", args: [n, body.length > 0] });
      if (failNext("issueComment", script.issueCommentFailures ?? [])) {
        throw new Error("simulated transient API hiccup (429)");
      }
      return `https://github.com/acme/widget/issues/${n}#issuecomment-77${(calls.length % 10) + 10}`;
    },
    labelCreate: async (name: string, color: string) => {
      calls.push({ method: "labelCreate", args: [name, color] });
      if (failNext("labelCreate", script.labelCreateFailures ?? [])) {
        throw new Error("simulated labelCreate hiccup");
      }
      return undefined;
    },
    labelAdd: async (target: "issue" | "mr", n: number, name: string) => {
      calls.push({ method: "labelAdd", args: [target, n, name] });
      if (failNext("labelAdd", script.labelAddFailures ?? [])) {
        throw new Error("simulated transient labelAdd hiccup");
      }
    },
    labelRemove: async () => {},
    issueView: async () => {
      throw new Error("not used");
    },
    issueCreate: async () => {
      throw new Error("not used");
    },
    issueEdit: async () => {
      throw new Error("not used");
    },
    issueSearch: async () => {
      throw new Error("not used");
    },
    prView: async () => {
      throw new Error("not used");
    },
    prList: async () => {
      throw new Error("not used");
    },
    prCreate: async () => {
      throw new Error("not used");
    },
    prMerge: async () => {
      throw new Error("not used");
    },
    prDiff: async () => {
      throw new Error("not used");
    },
    prChecks: async () => {
      throw new Error("not used");
    },
    ciWatch: async () => {
      throw new Error("not used");
    },
    ciRun: async () => {
      throw new Error("not used");
    },
    mergeReadiness: async () => {
      throw new Error("not used");
    },
    repoSettings: async () => {
      throw new Error("not used");
    },
  } as unknown as Forge;
  return { forge, calls };
}

function cappedState(issue: number): WorkState {
  const s = initialState(issue, 1_000_000);
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "step-failed:explore",
    reviewRound: 0,
    nextStep: "handoff",
  });
}

/** Zero backoff: the offline suite must not sleep. */
const fastOpts = { sleep: async () => {}, rand: () => 0 };

// ─────────────────────────────────────────────────────────────────────────
// 1. Flaky forge: issueComment fails ONCE, then succeeds → the retry wins.
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-post-retry-1-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
    const { forge, calls } = mkFlakyForge({ issueCommentFailures: [1] });
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 674,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(674), Date.now());

    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(emitted.length === 1, "exactly ONE handoff-emitted event is appended");
    assert(
      emitted[0]?.kind === "handoff-emitted" &&
        typeof emitted[0].commentUrl === "string" &&
        emitted[0].commentUrl.startsWith("https://github.com/acme/widget/issues/674#issuecomment-"),
      "the comment URL is the SECOND attempt's URL (retry succeeded after the first throw)",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === true,
      "the label is recorded as applied",
    );
    const commentCalls = calls.filter((c) => c.method === "issueComment");
    assert(
      commentCalls.length === 2,
      "forge.issueComment was called exactly TWICE (1 fail + 1 success)",
    );

    // The in-chat surface must NOT carry the INCOMPLETE banner.
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-674`);
    assert(
      !msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "no HANDOFF DISPATCH INCOMPLETE banner after a retry-then-success",
    );
    assert(
      msg.includes("GitHub handoff: https://github.com/acme/widget/issues/674#issuecomment-"),
      "the in-chat message reports the posted comment URL",
    );
  } finally {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Flaky label: comment ok, labelAdd fails ONCE → label retried + applied,
//    comment not re-posted (idempotency: the comment URL is already recorded).
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-post-retry-2-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
    const { forge, calls } = mkFlakyForge({ labelAddFailures: [1] });
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 674,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(674), Date.now());

    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted.length === 1,
      "exactly ONE handoff-emitted event (comment not re-posted on label retry)",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && typeof emitted[0].commentUrl === "string",
      "the comment URL is preserved from the first (successful) comment attempt",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === true,
      "the label is recorded as applied after the retry",
    );
    const commentCalls = calls.filter((c) => c.method === "issueComment");
    const addCalls = calls.filter((c) => c.method === "labelAdd");
    assert(
      commentCalls.length === 1,
      "forge.issueComment called exactly ONCE (it succeeded first try)",
    );
    assert(addCalls.length === 2, "forge.labelAdd called exactly TWICE (1 fail + 1 success)");
  } finally {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Hard-fail forge: every call throws → retries exhausted → banner appears
//    with the verbatim manual gh commands.
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-post-retry-3-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
    const { forge, calls } = mkFlakyForge({
      issueCommentFailures: [1, 2, 3],
      labelAddFailures: [1, 2, 3],
    });
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 674,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(674), Date.now());

    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(emitted.length === 1, "exactly ONE handoff-emitted event even on exhaustion");
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].commentUrl === undefined,
      "commentUrl is undefined after all 3 comment attempts failed",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === false,
      "labelApplied is false after all 3 label attempts failed",
    );
    const commentCalls = calls.filter((c) => c.method === "issueComment");
    const addCalls = calls.filter((c) => c.method === "labelAdd");
    assert(commentCalls.length === 3, "forge.issueComment was retried up to the 3-attempt bound");
    assert(addCalls.length === 3, "forge.labelAdd was retried up to the 3-attempt bound");

    // The banner MUST appear now, with the verbatim manual gh commands.
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-674`);
    assert(
      msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "the HANDOFF DISPATCH INCOMPLETE banner appears after retries are exhausted",
    );
    assert(
      msg.includes("gh issue comment 674 --body-file") &&
        msg.includes("--add-label needs-human-attention"),
      "the banner carries the verbatim manual gh commands",
    );
  } finally {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Invariant — a healthy dispatch (URL + label) does NOT trigger the forge
//    post at all (the retry loop must not run when there is nothing to post).
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-post-retry-4-"));
  try {
    const { forge, calls } = mkFlakyForge({});
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 674,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted https://github.com/acme/widget/issues/674#issuecomment-999 and labelled",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    await runHandoff(ctx, cappedState(674), Date.now());
    assert(
      !calls.some((c) => c.method === "issueComment"),
      "a healthy dispatch does NOT trigger the forge's issueComment (retry loop skipped)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Unit — postHandoffWithRetry escape hatch: PI_ENSEMBLE_HANDOFF_POST_RETRY=0
//    restores single-attempt behaviour (a flaky forge is NOT retried).
// ─────────────────────────────────────────────────────────────────────────
{
  const { forge, calls } = mkFlakyForge({ issueCommentFailures: [1] });
  process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY = "0";
  process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
  try {
    assert(handoffPostRetryEnabled() === false, "the escape hatch disables the retry");
    const res = await postHandoffWithRetry(forge, {
      issue: 674,
      body: "x",
      targetId: 674,
      objType: "issue",
      needsComment: true,
      needsLabel: false,
      ...fastOpts,
    });
    assert(res.commentUrl === undefined, "single-attempt mode: a failed comment is not retried");
    const commentCalls = calls.filter((c) => c.method === "issueComment");
    assert(commentCalls.length === 1, "single-attempt mode: issueComment called exactly ONCE");
  } finally {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY = undefined;
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Unit — the backoff schedule is jittered linear (deterministic with an
//    injected rand) and the injected sleep is actually awaited between
//    attempts (the offline seam must not block on the real clock).
// ─────────────────────────────────────────────────────────────────────────
{
  const { forge } = mkFlakyForge({ issueCommentFailures: [1, 2] });
  const sleeps: number[] = [];
  process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "100";
  try {
    const res = await postHandoffWithRetry(forge, {
      issue: 674,
      body: "x",
      targetId: 674,
      objType: "issue",
      needsComment: true,
      needsLabel: false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      rand: () => 1, // full jitter ceiling: wait == base
      now: () => 1_700_000_000_000,
    });
    assert(typeof res.commentUrl === "string", "the third attempt's URL is returned");
    assert(
      sleeps.length === 2 && sleeps[0] === 100 && sleeps[1] === 200,
      `backoff is linear + full-jitter (slept [${sleeps.join(", ")}] = 100 then 200)`,
    );
  } finally {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = undefined;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
