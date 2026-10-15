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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { projectIssue } from "../src/headless/result.ts";
import { attachHandoffBodies } from "../src/headless/run.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  handoffChannel,
  handoffMarker,
  parseHandoffMarker,
  withHandoffMarker,
} from "../src/work-driver-handoff-channel.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
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
    await attachHandoffBodies([r]);
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

// ── 5. No handoff → no handoff field; a non-park cap has no parkReason.
{
  const r = projectIssue(capped(503, "round-cap"), "state.json");
  assert(r.handoff === undefined && r.parkReason === undefined, "no handoff yet → neither field");
}

if (savedEnv === undefined) delete process.env[ENV];
else process.env[ENV] = savedEnv;
console.log(`\nexit ${exit}`);
process.exit(exit);
