#!/usr/bin/env bun
/**
 * #775 (workstream `banner-tests`) — the HANDOFF DISPATCH INCOMPLETE banner
 * fires only on TRUE total failure.
 *
 * Acceptance criterion: the "Post manually now" banner must be emitted only
 * when BOTH the ops dispatch AND the in-process forge fallback failed to
 * deliver — never on a first-dispatch miss that the fallback then succeeds
 * at. The #730/#655/#736 evidence spans three shapes (comment, label, both);
 * this matrix covers each per delivery path:
 *
 *   A. dispatch success (verified label + parsed URL) → NO banner
 *   B. dispatch failure → fallback comment-only failure (label ok) → NO banner
 *   C. dispatch failure → fallback label-only failure (comment ok) → NO banner
 *   D. dispatch failure → fallback total failure → banner fires
 *   E. dispatch failure → no forge (true last resort) → banner fires
 *
 * Plus the idempotency matrix for the in-process fallback's existing-comment
 * check (the dispatch-posted-but-URL-lost shape):
 *
 *   F. body matches existing comment → URL reused, NO re-post
 *   G. body does NOT match → fallback posts exactly once
 *   H. body is empty (missing body file) → no false match; fallback posts
 */

import { exec as _exec } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify as _promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { postHandoffWithRetry } from "../src/work-driver-handoff-post-retry.ts";
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
const execp = _promisify(_exec);

const fakePi = {
  sendUserMessage: () => undefined,
} as unknown as ExtensionAPI;

function failingDispatch(): DriverContext["dispatchFn"] {
  return async (): Promise<DispatchResult> => {
    throw new Error("ops dispatch failed (simulated)");
  };
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

import { mkScriptedForge } from "./lib/handoff-scripted-forge.ts";

const fastOpts = { sleep: async () => {}, rand: () => 0 };

// A. Dispatch success (verified label + parsed URL) → NO banner, no post.
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-A-"));
  try {
    const { forge, calls } = mkScriptedForge({ label: true });
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 730,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "Label applied and confirmed present.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/730#issuecomment-999 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(730), Date.now());
    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted[0]?.kind === "handoff-emitted" &&
        emitted[0].commentUrl === "https://github.com/acme/widget/issues/730#issuecomment-999",
      "A: URL from the ops reply is recorded",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === true,
      "A: verified label recorded as applied (never the hard-coded false)",
    );
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-730`);
    assert(
      !msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "A: no banner on a fully delivered handoff",
    );
    assert(!msg.includes("Post manually now"), "A: no 'Post manually now' on success");
    assert(
      !calls.some((c) => c.method === "issueComment" || c.method === "labelAdd"),
      "A: fallback did not re-post (no issueComment/labelAdd calls)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B. Dispatch failure → fallback comment-only failure (label ok) → NO banner.
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-B-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY = "0";
    const { forge, calls } = mkScriptedForge({ label: true });
    (forge as unknown as { issueComment: unknown }).issueComment = async () => {
      calls.push({ method: "issueComment", args: ["THREW"] });
      throw new Error("simulated comment post failure");
    };
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 655,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(655), Date.now());
    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === true,
      "B: label recorded applied (it was verifiable)",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].commentUrl === undefined,
      "B: comment honestly recorded as undelivered",
    );
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-655`);
    assert(
      !msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "B: no banner — partial failure (label ok) is not total failure",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY;
    rmSync(dir, { recursive: true, force: true });
  }
}

// C. Dispatch failure → fallback label-only failure (comment ok) → NO banner.
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-C-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY = "0";
    const { forge } = mkScriptedForge({ labelAddFailures: 99 });
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 736,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(736), Date.now());
    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted[0]?.kind === "handoff-emitted" &&
        emitted[0].commentUrl === "https://github.com/acme/widget/issues/736#issuecomment-4242",
      "C: fallback-posted comment URL is recorded",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].labelApplied === false,
      "C: undelivered label honestly recorded false",
    );
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-736`);
    assert(
      !msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "C: no banner — partial failure (comment ok) is not total failure",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY;
    rmSync(dir, { recursive: true, force: true });
  }
}

// D. Dispatch failure → fallback total failure → banner fires.
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-D-"));
  try {
    process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY = "0";
    const { forge } = mkScriptedForge({ labelAddFailures: 99 });
    (forge as unknown as { issueComment: unknown }).issueComment = async () => {
      throw new Error("simulated comment post failure");
    };
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 758,
      dispatchFn: failingDispatch(),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(758), Date.now());
    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted[0]?.kind === "handoff-emitted" &&
        emitted[0].commentUrl === undefined &&
        emitted[0].labelApplied === false,
      "D: both fields honestly recorded as undelivered",
    );
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-758`);
    assert(msg.includes("HANDOFF DISPATCH INCOMPLETE"), "D: banner fires on TRUE total failure");
    assert(msg.includes("Post manually now"), "D: banner carries the manual recovery");
    assert(
      msg.includes("gh issue comment 758 --body-file") &&
        msg.includes("--add-label needs-human-attention"),
      "D: banner carries the verbatim manual gh commands",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY;
    rmSync(dir, { recursive: true, force: true });
  }
}

// E. Dispatch failure → no forge (PI_ENSEMBLE_FORGE=none) → banner fires.
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-E-"));
  try {
    process.env.PI_ENSEMBLE_FORGE = "none";
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 759,
      dispatchFn: failingDispatch(),
      forge: undefined,
    };
    const next = await runHandoff(ctx, cappedState(759), Date.now());
    const emitted = next.eventLog.filter((e) => e.kind === "handoff-emitted");
    assert(
      emitted[0]?.kind === "handoff-emitted" &&
        emitted[0].commentUrl === undefined &&
        emitted[0].labelApplied === false,
      "E: nothing delivered — both fields honestly negative",
    );
    assert(
      emitted[0]?.kind === "handoff-emitted" && emitted[0].delivery === undefined,
      "E: no delivery provenance (fallback structurally impossible)",
    );
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-759`);
    assert(
      msg.includes("HANDOFF DISPATCH INCOMPLETE"),
      "E: banner fires (the one true last resort)",
    );
    assert(msg.includes("Post manually now"), "E: banner carries the manual recovery");
  } finally {
    delete process.env.PI_ENSEMBLE_FORGE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// F. Idempotency: body matches existing comment → URL reused, no re-post.
{
  const body = "the handoff body that the dispatch already posted";
  const { forge, calls } = mkScriptedForge({
    comments: [{ body, url: "https://github.com/acme/widget/issues/775#issuecomment-1234" }],
  });
  const out = await postHandoffWithRetry(
    forge,
    {
      issue: 775,
      body,
      expectedBody: body,
      targetId: 775,
      objType: "issue",
      needsComment: true,
      needsLabel: false,
      existingComments: await forge.issueComments(775),
    },
    { ...fastOpts },
  );
  assert(
    out.commentUrl === "https://github.com/acme/widget/issues/775#issuecomment-1234",
    "F: existing comment's URL is reused (not a fresh post)",
  );
  assert(
    !calls.some((c) => c.method === "issueComment"),
    "F: no re-post (body-matching short-circuit)",
  );
}

// G. Idempotency: body does NOT match → fallback posts exactly once.
{
  const body = "a fresh handoff body";
  const { forge, calls } = mkScriptedForge({
    comments: [{ body: "an unrelated older comment" }],
  });
  const out = await postHandoffWithRetry(
    forge,
    {
      issue: 775,
      body,
      expectedBody: body,
      targetId: 775,
      objType: "issue",
      needsComment: true,
      needsLabel: false,
      existingComments: await forge.issueComments(775),
    },
    { ...fastOpts },
  );
  assert(
    typeof out.commentUrl === "string" && out.commentUrl.endsWith("#issuecomment-4242"),
    "G: non-matching comment is not treated as ours — fallback posts",
  );
  assert(calls.filter((c) => c.method === "issueComment").length === 1, "G: exactly one post");
}

// H. Idempotency: an EMPTY body neither matches an existing empty comment nor
//    gets posted. Two rules, one string: the empty value must not fake an
//    idempotent skip (#775), and since #1820 it must not post either — a comment
//    that carries nothing discloses nothing yet returns a URL, which would read
//    as a delivered handoff. The label still applies; the comment does not.
{
  const { forge, calls } = mkScriptedForge({
    comments: [{ body: "" }],
  });
  const out = await postHandoffWithRetry(
    forge,
    {
      issue: 775,
      body: "",
      expectedBody: "",
      targetId: 775,
      objType: "issue",
      needsComment: true,
      needsLabel: false,
      existingComments: await forge.issueComments(775),
    },
    { ...fastOpts },
  );
  assert(
    out.commentUrl === undefined,
    "H: an empty body is NOT posted — no URL is claimed for a comment that says nothing (#1820)",
  );
  assert(
    calls.filter((c) => c.method === "issueComment").length === 0,
    "H: the empty body never reaches the forge's comment seam",
  );
  assert(
    out.labelApplied === false,
    "H: the run recorded no delivery of any kind (this case asks for no label either)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
