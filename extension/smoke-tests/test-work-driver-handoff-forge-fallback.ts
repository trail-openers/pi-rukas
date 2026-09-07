#!/usr/bin/env bun
/**
 * #612 S4 task-b — the in-process handoff fallback is now forge-aware.
 *
 * Pre-migration, `runHandoff`'s fallback (the path that fires when the ops
 * dispatch fails or outlives its bound) shelled out to raw `gh` via a
 * module-local `execp`: `gh issue|pr comment --body-file`, `gh label create`,
 * `gh issue|pr edit --add-label`. No injection seam, no offline test.
 *
 * The forge adapter (S2, #610) normalizes those calls behind a `Forge`
 * interface. This test drives the fallback with a fake `Forge` (injected via
 * `ctx.forge`, the new DriverContext seam) and a failing `dispatchFn`, and
 * asserts:
 *
 *   - The forge's `issueComment` is called for the issue target (no PR).
 *   - The forge's `labelCreate` + `labelAdd("issue", ...)` are called.
 *   - The handoff-emitted event records the parsed comment URL.
 *   - The label is recorded as applied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

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

/** A failing dispatch that never returns a URL or label. */
function failingDispatch(): DriverContext["dispatchFn"] {
  return async (_pi: ExtensionAPI, _spec, _opts): Promise<DispatchResult> => {
    throw new Error("ops dispatch failed (simulated)");
  };
}

/** A fake Forge that records calls and returns canned values. */
function mkFakeForge(): {
  forge: Forge;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueComment: async (n: number, body: string) => {
      calls.push({ method: "issueComment", args: [n, body.length > 0] });
      return `https://github.com/acme/widget/issues/${n}#issuecomment-4242`;
    },
    labelCreate: async (name: string, color: string) => {
      calls.push({ method: "labelCreate", args: [name, color] });
      return undefined;
    },
    labelAdd: async (target: "issue" | "mr", n: number, name: string) => {
      calls.push({ method: "labelAdd", args: [target, n, name] });
    },
    labelRemove: async () => {},
    issueView: async () => {
      throw new Error("not used in this test");
    },
    issueCreate: async () => {
      throw new Error("not used in this test");
    },
    issueEdit: async () => {
      throw new Error("not used in this test");
    },
    issueSearch: async () => {
      throw new Error("not used in this test");
    },
    prView: async () => {
      throw new Error("not used in this test");
    },
    prList: async () => {
      throw new Error("not used in this test");
    },
    prCreate: async () => {
      throw new Error("not used in this test");
    },
    prMerge: async () => {
      throw new Error("not used in this test");
    },
    prDiff: async () => {
      throw new Error("not used in this test");
    },
    prChecks: async () => {
      throw new Error("not used in this test");
    },
    ciWatch: async () => {
      throw new Error("not used in this test");
    },
    ciRun: async () => {
      throw new Error("not used in this test");
    },
    mergeReadiness: async () => {
      throw new Error("not used in this test");
    },
    repoSettings: async () => {
      throw new Error("not used in this test");
    },
  } as unknown as Forge;
  return { forge, calls };
}

function cappedState(issue: number) {
  const s = initialState(issue, 1_000_000);
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "step-failed:explore",
    reviewRound: 0,
    nextStep: "handoff",
  });
}

// 1. CANARY — the fallback drives the forge, not raw gh.
//
// A failing dispatch (no URL, no label) triggers the in-process fallback.
// The forge's issueComment + labelCreate + labelAdd must be called; the
// handoff-emitted event must carry the parsed URL and labelApplied: true.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-forge-"));
  try {
    const { forge, calls } = mkFakeForge();
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(626), Date.now());

    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted !== undefined,
      "handoff-emitted is appended (the fallback ran)",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-4242",
      "the comment URL is parsed from the forge's issueComment return value",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === true,
      "the label is recorded as applied (the forge's labelAdd succeeded)",
    );

    // The forge must have been called: issueComment (for the issue target),
    // labelCreate (idempotent create), and labelAdd("issue", 626, ...).
    const commentCall = calls.find((c) => c.method === "issueComment");
    assert(commentCall !== undefined, "forge.issueComment was called (the comment was posted via the forge)");
    assert(
      commentCall?.args[0] === 626,
      "the comment targeted the issue number (626, no PR)",
    );
    const createCall = calls.find((c) => c.method === "labelCreate");
    assert(
      createCall !== undefined &&
        createCall.args[0] === "needs-human-attention" &&
        createCall.args[1] === "FFAA00",
      "forge.labelCreate was called with the attention label + color",
    );
    const addCall = calls.find((c) => c.method === "labelAdd");
    assert(
      addCall !== undefined &&
        addCall.args[0] === "issue" &&
        addCall.args[1] === 626 &&
        addCall.args[2] === "needs-human-attention",
      'forge.labelAdd was called with target "issue" (no PR), the issue number, and the label name',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. The handoff body file is read by the forge (the forge takes the body
// string, not the file path — the driver reads the file and passes it).
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-forge-body-"));
  try {
    const { forge, calls } = mkFakeForge();
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: failingDispatch(),
      forge,
    };
    // runHandoff writes the handoff body to <scratchDir>/handoff-comment.md
    // before the dispatch. The forge's issueComment receives the body string
    // (the driver reads the file). We assert the body was non-empty.
    await runHandoff(ctx, cappedState(626), Date.now());
    const commentCall = calls.find((c) => c.method === "issueComment");
    // args[1] is `body.length > 0` (a boolean) in our fake — but the real
    // forge takes the string. The fake records the length, so we assert
    // the body was non-empty (the file was written and read).
    assert(
      commentCall !== undefined && commentCall.args[1] === true,
      "the forge received a non-empty body (the handoff file was read and passed)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. INVARIANT — a healthy dispatch (URL + label from the ops reply) does
// NOT trigger the forge fallback. The forge must NOT be called.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-forge-invariant-"));
  try {
    const { forge, calls } = mkFakeForge();
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted https://github.com/acme/widget/issues/626#issuecomment-999 and labelled",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    await runHandoff(ctx, cappedState(626), Date.now());
    // The comment URL is parsed from the ops reply, but the label is NOT
    // parsed (the #408 fix made label application mechanical: the driver
    // always runs labelCreate + labelAdd because `gh --add-label` is
    // idempotent and narration cannot establish a side effect happened).
    // So the forge's labelCreate + labelAdd ARE called even on a healthy
    // dispatch — only the issueComment is skipped.
    assert(
      !calls.some((c) => c.method === "issueComment"),
      "a healthy dispatch does NOT trigger the forge's issueComment (the URL was already parsed)",
    );
    assert(
      calls.some((c) => c.method === "labelCreate") &&
        calls.some((c) => c.method === "labelAdd"),
      "the label IS applied mechanically (idempotent) even on a healthy dispatch",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
