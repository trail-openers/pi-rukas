#!/usr/bin/env bun
/**
 * #808 — the terminal driver line must actually arrive.
 *
 * Observed on cycles #765/#782: the cycle parked, wrote a complete handoff to
 * disk, posted its comment and applied its label — and told the operator
 * nothing. Forensics showed the terminal `notifyAgent` call was (a) unguarded
 * (a throw escaped into the async-job rejection path, untraced) and (b)
 * paired with a WRITE-AHEAD `handoffDeliveredAt` marker, so the very failure
 * that lost the line also disabled re-delivery on resume.
 *
 * These tests assert at the delivery seam:
 *   1. successful send → `handoffDeliveredAt` set AFTER the send (not before)
 *   2. delivery throw  → traced, marker NOT set, second attempt delivers
 *   3. already-delivered guard → no re-send
 *   4. merged line carries the `pi-rukas:driver-event v1 kind=merged` envelope
 *   5. handoff line still carries its kind=handoff envelope (unchanged)
 */

import { notifyAgent } from "../src/agent-message.ts";
import {
  deliverTerminalLine,
  type TerminalDeliveryCtx,
} from "../src/work-driver-terminal-delivery.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(issue: number, status: "merged" | "handoff" | "aborted") {
  let s = initialState(issue, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status,
      currentStep: status === "merged" ? "merged" : "handoff",
    },
  };
  if (status !== "merged") {
    s = {
      ...s,
      eventLog: [
        ...s.eventLog,
        { kind: "cap-hit", at: 999_000, cap: "round-cap", reviewRound: 1, nextStep: "handoff" },
      ],
    };
  }
  return s;
}

function makeCtx(
  pi: TerminalDeliveryCtx["pi"],
  issue = 808,
): TerminalDeliveryCtx {
  return { repoRoot: "/repo", issue, pi };
}

// ---------------------------------------------------------------------------
// 1. Successful send → handoffDeliveredAt set AFTER the send
// ---------------------------------------------------------------------------
{
  let markerSetAtSend = true; // flipped to false if marker was already set when send fired
  let delivered = false;
  const fakePi = {
    sendUserMessage(text: string) {
      delivered = true;
      // At the moment the send fires, the marker must still be unset —
      // send-first, then record.
      markerSetAtSend = stateRef.pipelineState.handoffDeliveredAt === undefined;
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  let stateRef = makeState(808, "handoff");

  const result = await deliverTerminalLine(makeCtx(fakePi), stateRef);
  assert(delivered, "handoff: send fires");
  assert(
    markerSetAtSend,
    "handoff: handoffDeliveredAt is NOT set when sendUserMessage fires (send-first)",
  );
  assert(
    typeof result.pipelineState.handoffDeliveredAt === "string" &&
      result.pipelineState.handoffDeliveredAt.includes("T") &&
      result.pipelineState.handoffDeliveredAt.endsWith("Z"),
    "handoff: handoffDeliveredAt set to ISO timestamp AFTER successful send",
  );
}

// ---------------------------------------------------------------------------
// 2. Delivery throw → traced, marker NOT set, second attempt delivers
// ---------------------------------------------------------------------------
{
  let callCount = 0;
  const fakePi = {
    sendUserMessage() {
      callCount += 1;
      if (callCount === 1) throw new Error("Agent is already processing. Specify streamingBehavior");
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  let stateRef = makeState(808, "handoff");

  const result1 = await deliverTerminalLine(makeCtx(fakePi), stateRef);
  assert(callCount === 1, "throw: first send attempted exactly once");
  assert(
    result1.pipelineState.handoffDeliveredAt === undefined,
    "throw: handoffDeliveredAt NOT set after a failed send — resume can re-attempt",
  );

  // Second attempt (simulating a resume) delivers successfully.
  const result2 = await deliverTerminalLine(makeCtx(fakePi), result1);
  assert(callCount === 2, "throw: second attempt fires a new send");
  assert(
    result2.pipelineState.handoffDeliveredAt !== undefined,
    "throw: after the retry succeeds, handoffDeliveredAt is set",
  );
}

// ---------------------------------------------------------------------------
// 3. Already-delivered guard → no re-send (resume with marker set)
// ---------------------------------------------------------------------------
{
  let callCount = 0;
  const fakePi = {
    sendUserMessage() {
      callCount += 1;
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  let s = makeState(808, "handoff");
  s = {
    ...s,
    pipelineState: { ...s.pipelineState, handoffDeliveredAt: "2026-01-01T00:00:00.000Z" },
  };

  const result = await deliverTerminalLine(makeCtx(fakePi), s);
  assert(callCount === 0, "guard: already-delivered handoff is NOT re-sent");
  assert(result === s, "guard: state passes through unchanged");
}

// ---------------------------------------------------------------------------
// 4. Merged line carries the driver-event envelope
// ---------------------------------------------------------------------------
{
  let deliveredText = "";
  const fakePi = {
    sendUserMessage(text: string) {
      deliveredText = text;
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  const s = makeState(808, "merged");

  const result = await deliverTerminalLine(makeCtx(fakePi), s);
  const firstLine = deliveredText.split("\n")[0];
  assert(
    firstLine.startsWith("pi-rukas:driver-event v1 kind=merged issue=808 at="),
    "merged: first line is the pi-rukas:driver-event v1 kind=merged envelope",
  );
  assert(
    deliveredText.includes("MERGED ✓"),
    "merged: the MERGED ✓ body line is still present after the envelope",
  );
  assert(
    result === s,
    "merged: marker is not recorded (nothing to re-deliver — the line is idempotent)",
  );
}

// ---------------------------------------------------------------------------
// 5. Handoff line carries the kind=handoff envelope (unchanged by #808)
// ---------------------------------------------------------------------------
{
  let deliveredText = "";
  const fakePi = {
    sendUserMessage(text: string) {
      deliveredText = text;
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  const s = makeState(808, "handoff");

  await deliverTerminalLine(makeCtx(fakePi), s);
  const firstLine = deliveredText.split("\n")[0];
  assert(
    firstLine.startsWith("pi-rukas:driver-event v1 kind=handoff issue=808 at="),
    "handoff: first line is the pi-rukas:driver-event v1 kind=handoff envelope (format unchanged)",
  );
}

// ---------------------------------------------------------------------------
// 6. notifyAgent contract still holds at the terminal seam (deliverAs: steer)
// ---------------------------------------------------------------------------
{
  const calls: Array<{ text: string; options?: { deliverAs?: string } }> = [];
  const fakePi = {
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      calls.push({ text, options });
    },
  } as unknown as TerminalDeliveryCtx["pi"];
  const s = makeState(808, "merged");

  await deliverTerminalLine(makeCtx(fakePi), s);
  assert(
    calls.length === 1 && calls[0]?.options?.deliverAs === "steer",
    "terminal delivery routes through notifyAgent with deliverAs:steer (mid-turn safe)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
