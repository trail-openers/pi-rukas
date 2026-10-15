#!/usr/bin/env bun
/**
 * #1327 — a host can own the handoff channel.
 *
 *   - `PI_ENSEMBLE_HANDOFF_CHANNEL` defaults to `forge`; only `host` selects host.
 *   - The handoff body carries `<!-- pi-rukas:handoff issue=N cap=<cap> -->`
 *     as its first line, in the posted comment too (forge channel).
 *   - Host channel: no ops dispatch, no forge comment, no label; the
 *     handoff-emitted event records `delivery: "host"` and the chat message
 *     shows no "DISPATCH INCOMPLETE" banner.
 *   - The headless result carries the handoff (channel, marker, full body)
 *     and an intent park's reason.
 *   - `--capabilities` lists the input and the features.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  handoffChannel,
  handoffMarker,
  parseHandoffMarker,
  withHandoffMarker,
} from "../src/work-driver-handoff-channel.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runHandoff, setHandoffThrowForTestForTest } from "../src/work-driver-handoff.ts";
import { setPlanThrowForTestForTest } from "../src/work-driver-plan.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import {
  type WorkState,
  appendEvent,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ENV = "PI_ENSEMBLE_HANDOFF_CHANNEL";
const savedEnv = process.env[ENV];
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

// ── 1. The input: default forge, `host` (any case) selects host.
{
  delete process.env[ENV];
  assert(handoffChannel() === "forge", "unset → forge (today's behaviour)");
  process.env[ENV] = "HOST";
  assert(handoffChannel() === "host", "HOST → host (case-folded)");
  process.env[ENV] = "github";
  assert(handoffChannel() === "forge", "an unknown value falls back to forge");
  delete process.env[ENV];
  const caps = buildCapabilities();
  const input = caps.inputs.find((i) => i.name === ENV);
  assert(
    input?.type === "enum" && input.default === "forge" && input.values?.join() === "forge,host",
    "--capabilities lists PI_ENSEMBLE_HANDOFF_CHANNEL as enum forge|host, default forge",
  );
  assert(caps.features.handoffChannel === true, "features.handoffChannel is true");
  assert(caps.features.restartClearsAttention === true, "features.restartClearsAttention is true");
}

// ── 2. The marker.
{
  assert(
    handoffMarker(42, "verify-failed:develop") ===
      "<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->",
    "the marker names the issue and the typed cap",
  );
  assert(handoffMarker(42, undefined).endsWith("cap=none -->"), "no cap → cap=none");
  assert(
    !handoffMarker(1, "x --> y").slice(0, -4).includes("-->"),
    "a cap cannot close the comment",
  );
  const parsed = parseHandoffMarker(`hello\n${handoffMarker(7, "round-cap")}\nbody`);
  assert(parsed?.issue === 7 && parsed.cap === "round-cap", "the marker parses back");
  const s = capped(7, "round-cap");
  const once = withHandoffMarker("# body", s);
  assert(once.startsWith(handoffMarker(7, "round-cap")), "the marker is the body's first line");
  assert(withHandoffMarker(once, s) === once, "adding the marker is idempotent");
}

function capped(issue: number, cap: string, parkReason?: string): WorkState {
  return appendEvent(initialState(issue, 1_000_000), {
    kind: "cap-hit",
    at: 1_000_400,
    cap,
    reviewRound: 0,
    nextStep: "handoff",
    ...(parkReason ? { parkReason } : {}),
  } as Parameters<typeof appendEvent>[1]);
}

/** A forge that records every call; comment/label calls succeed, reads fail. */
function recordingForge(): { forge: Forge; calls: string[]; bodies: string[] } {
  const calls: string[] = [];
  const bodies: string[] = [];
  const forge = new Proxy(
    { forge: "github", host: "github.com", owner: "a", repo: "b" } as object,
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push(String(prop));
          if (prop === "issueComment") {
            bodies.push(String(args[1]));
            return `https://github.com/a/b/issues/${args[0]}#issuecomment-1`;
          }
          if (prop === "labelCreate" || prop === "labelAdd") return undefined;
          throw new Error(`${String(prop)} unavailable`);
        };
      },
    },
  ) as Forge;
  return { forge, calls, bodies };
}

function mkCtx(dir: string, issue: number, forge: Forge, dispatched: string[]): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue,
    forge,
    dispatchFn: async (_pi, spec): Promise<DispatchResult> => {
      dispatched.push(String((spec as { label?: string }).label ?? "dispatch"));
      throw new Error("ops dispatch failed (simulated)");
    },
  };
}

// ── 3. Forge channel: the posted comment carries the marker.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-channel-forge-"));
  try {
    delete process.env[ENV];
    const { forge, bodies } = recordingForge();
    const next = await runHandoff(mkCtx(dir, 501, forge, []), capped(501, "round-cap"), Date.now());
    const marker = handoffMarker(501, "round-cap");
    assert(
      bodies.length === 1 && bodies[0]?.startsWith(marker) === true,
      "forge: the posted comment starts with the marker",
    );
    const ev = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(ev?.kind === "handoff-emitted" && ev.delivery !== "host", "forge: delivery is not host");
    // Byte-identical apart from the marker line: the posted comment, the body
    // file and the recorded body are one text, and stripping the marker line
    // gives exactly what the renderer produced for the state it rendered.
    const posted = bodies[0] ?? "";
    const file = readFileSync(path.join(dir, "tmp", "issue-501", "handoff-comment.md"), "utf8");
    assert(
      file === posted && ev?.kind === "handoff-emitted" && ev.body === posted,
      "forge: posted = file = recorded body",
    );
    const rendered = renderHandoffMarkdown(
      {
        ...next,
        pipelineState: { ...next.pipelineState, status: "running" },
        eventLog: next.eventLog.filter(
          // The state as rendered: before the ops dispatch and the emitted event.
          (e) =>
            e.kind !== "handoff-emitted" &&
            !(e.kind.startsWith("dispatch-") && "step" in e && e.step === "handoff"),
        ),
      },
      "github",
    );
    assert(
      posted === `${marker}\n${rendered}`,
      "forge: the body is the renderer's output with only the marker line added",
    );
    const r = projectIssue(next, "state.json");
    assert(r.handoff?.channel === "forge", "forge: the result's handoff channel is forge");
    assert(
      r.handoff?.commentUrl?.endsWith("#issuecomment-1") === true,
      "forge: the result names the comment",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. Host channel: nothing posted, nothing labelled, body in the result.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-channel-host-"));
  try {
    process.env[ENV] = "host";
    const { forge, calls } = recordingForge();
    const dispatched: string[] = [];
    const state = capped(502, "intent-park", "too-large");
    const next = await runHandoff(mkCtx(dir, 502, forge, dispatched), state, Date.now());
    const writes = calls.filter((c) => /comment|label/i.test(c));
    assert(
      writes.length === 0,
      `host: no forge comment or label call (saw: ${writes.join(",") || "none"})`,
    );
    assert(dispatched.length === 0, "host: the ops handoff dispatch is not run");
    const ev = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      ev?.kind === "handoff-emitted" &&
        ev.delivery === "host" &&
        !ev.commentUrl &&
        !ev.labelApplied,
      "host: handoff-emitted records delivery host, no comment, no label",
    );
    assert(next.pipelineState.status === "handoff", "host: the cycle still ends in handoff");
    const msg = renderHandoffUserMessage(next, dir, `${dir}/scratch`);
    assert(!msg.includes("DISPATCH INCOMPLETE"), "host: no DISPATCH INCOMPLETE banner");
    assert(msg.includes("Handoff channel: host"), "host: the chat message names the host channel");

    const r = projectIssue(next, "state.json");
    const marker = handoffMarker(502, "intent-park");
    assert(
      r.cap === "intent-park" && r.parkReason === "too-large",
      "host: typed cap and park reason in the result",
    );
    assert(
      r.handoff?.channel === "host" && r.handoff.marker === marker,
      "host: result handoff channel + marker",
    );
    assert(
      r.handoff?.labelApplied === false && !r.handoff.commentUrl,
      "host: result records nothing posted",
    );
    assert(
      typeof r.handoff?.body === "string" &&
        r.handoff.body.startsWith(marker) &&
        r.handoff.body.length > marker.length + 20,
      "host: the full handoff body (marker first) is in the result",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. Host: a failed body-file write loses nothing, and the result never
//    reads the file, so a stale or overwritten file cannot replace the body.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-channel-nofile-"));
  try {
    process.env[ENV] = "host";
    mkdirSync(path.join(dir, "tmp"), { recursive: true });
    writeFileSync(path.join(dir, "tmp", "issue-504"), "a file where the scratch dir goes");
    const { forge } = recordingForge();
    const next = await runHandoff(mkCtx(dir, 504, forge, []), capped(504, "round-cap"), Date.now());
    const r = projectIssue(next, "state.json");
    assert(
      r.handoff?.body?.startsWith(handoffMarker(504, "round-cap")) === true && !r.handoff.bodyError,
      "host: the body reaches the result even when its file could not be written",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = mkdtempSync(path.join(tmpdir(), "handoff-channel-stale-"));
  try {
    const { forge } = recordingForge();
    const next = await runHandoff(
      mkCtx(dir2, 505, forge, []),
      capped(505, "round-cap"),
      Date.now(),
    );
    const file = path.join(dir2, "tmp", "issue-505", "handoff-comment.md");
    writeFileSync(file, "STALE body from another cycle");
    const r = projectIssue(next, "state.json");
    assert(
      r.handoff?.body?.includes("STALE") === false,
      "host: a rewritten body file does not change the result",
    );
    const restarted = projectIssue(initialState(505, Date.now()), "state.json");
    assert(
      restarted.handoff === undefined,
      "host: a restarted cycle reports no earlier cycle's body",
    );
    const legacy = {
      ...next,
      eventLog: next.eventLog.map((e) =>
        e.kind === "handoff-emitted" ? { ...e, body: undefined } : e,
      ),
    };
    const lr = projectIssue(legacy as WorkState, "state.json");
    assert(
      lr.handoff?.body === undefined && lr.handoff?.bodyError === "not-recorded",
      "an event without a body says so",
    );
  } finally {
    delete process.env[ENV];
    rmSync(dir2, { recursive: true, force: true });
  }
}

// ── 7. Host: the handoff step itself throws. The cycle aborts (no re-route),
//    but a handoff with a body is still recorded for the result.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-channel-crash-"));
  try {
    process.env[ENV] = "host";
    setPlanThrowForTestForTest(() => {
      throw new Error("simulated plan step crash");
    });
    setHandoffThrowForTestForTest(() => {
      throw new Error("simulated runHandoff crash");
    });
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const s0 = initialState(506, 1_000_000);
    await writeState(dir, {
      ...s0,
      pipelineState: {
        ...s0.pipelineState,
        currentStep: "plan",
        lastCompletedStep: "explore",
        status: "running",
      },
    } as WorkState);
    const { forge, calls } = recordingForge();
    const dispatched: string[] = [];
    const ctx = mkCtx(dir, 506, forge, dispatched);
    ctx.issueBodyFetcherFn = async (n: number) => ({
      stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody`,
    });
    await runWorkDriver(ctx);
    const final = await readState(dir, 506);
    assert(
      final?.pipelineState.status === "aborted",
      `crash: the cycle aborts (got ${final?.pipelineState.status})`,
    );
    const r = final ? projectIssue(final, "state.json") : undefined;
    assert(
      r?.handoff?.channel === "host" &&
        r.handoff.body?.startsWith(handoffMarker(506, "driver-crash:plan")) === true &&
        r.handoff.body.includes("simulated runHandoff crash"),
      "crash: the result carries a host handoff body naming the crash",
    );
    const writes = calls.filter((c) => /comment|label(Add|Create)/.test(c));
    assert(writes.length === 0, `crash: still nothing posted (saw: ${writes.join(",") || "none"})`);
  } finally {
    setPlanThrowForTestForTest(undefined);
    setHandoffThrowForTestForTest(undefined);
    delete process.env[ENV];
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. No handoff → no handoff field; a non-park cap has no parkReason.
{
  const r = projectIssue(capped(503, "round-cap"), "state.json");
  assert(r.handoff === undefined && r.parkReason === undefined, "no handoff yet → neither field");
}

if (savedEnv === undefined) delete process.env[ENV];
else process.env[ENV] = savedEnv;
console.log(`\nexit ${exit}`);
process.exit(exit);
