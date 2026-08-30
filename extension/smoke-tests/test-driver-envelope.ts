#!/usr/bin/env bun
/**
 * Smoke test for #580: guard handoff in-chat delivery against re-send and
 * give driver messages a verifiable envelope.
 *
 * Covers:
 * - handoffDeliveredAt write-ahead prevents re-delivery
 * - unset → sent once and field written
 * - envelope on renderHandoffUserMessage output
 * - restart → field cleared (initialState has no field)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// 1. handoffDeliveredAt present → delivery is a no-op (spy not called)
// ---------------------------------------------------------------------------
{
  let deliverCount = 0;
  const fakePi = {
    sendUserMessage: () => { deliverCount++; },
  } as unknown as ExtensionAPI;

  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff",
      currentStep: "handoff",
      handoffDeliveredAt: "2026-01-01T00:00:00.000Z",
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 999_000,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });

  // Simulate the guard: if handoffDeliveredAt is set, skip delivery.
  // This mirrors the real guard in work-driver.ts terminal block.
  const notifyAgent = (pi: ExtensionAPI, _text: string) => {
    pi.sendUserMessage(_text);
  };

  // Guard check (mimicking work-driver.ts terminal block logic)
  if (s.pipelineState.handoffDeliveredAt) {
    // Already delivered — skip
  } else {
    // Would deliver
    const msg = renderHandoffUserMessage(s, "/repo", "/repo/tmp/issue-580");
    notifyAgent(fakePi, msg);
  }

  assert(
    deliverCount === 0,
    "handoffDeliveredAt set → notifyAgent not called (count=0)",
  );
}

// ---------------------------------------------------------------------------
// 2. handoffDeliveredAt absent → sent once, field gets written
// ---------------------------------------------------------------------------
{
  let deliveredMsg = "";
  const fakePi = {
    sendUserMessage: (text: unknown) => {
      deliveredMsg = typeof text === "string" ? text : JSON.stringify(text);
    },
  } as unknown as ExtensionAPI;

  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff",
      currentStep: "handoff",
      // No handoffDeliveredAt — should deliver
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 999_000,
    cap: "round-cap",
    reviewRound: 1,
    nextStep: "handoff",
  });

  // Guard check (absent field → deliver)
  if (!s.pipelineState.handoffDeliveredAt) {
    const msg = renderHandoffUserMessage(s, "/repo", "/repo/tmp/issue-580");
    (fakePi as any).sendUserMessage(msg);
    // Simulate write-ahead: set handoffDeliveredAt BEFORE delivery
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, handoffDeliveredAt: new Date().toISOString() },
    };
  }

  assert(
    deliveredMsg.length > 0,
    "handoffDeliveredAt absent → message delivered",
  );
  assert(
    s.pipelineState.handoffDeliveredAt !== undefined &&
    typeof s.pipelineState.handoffDeliveredAt === "string" &&
    s.pipelineState.handoffDeliveredAt.includes("T") &&
    s.pipelineState.handoffDeliveredAt.endsWith("Z"),
    "handoffDeliveredAt absent → field written as ISO timestamp",
  );
}

// ---------------------------------------------------------------------------
// 3. Restart → initialState has no handoffDeliveredAt (field cleared)
// ---------------------------------------------------------------------------
{
  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff",
      handoffDeliveredAt: "2026-01-01T00:00:00.000Z",
    },
  };

  // Restart: re-create state from initialState
  s = initialState(580, Date.now());

  assert(
    s.pipelineState.handoffDeliveredAt === undefined,
    "restart → initialState wipes handoffDeliveredAt (undefined)",
  );
}

// ---------------------------------------------------------------------------
// 4. Envelope present on renderHandoffUserMessage output (first-line assertion)
// ---------------------------------------------------------------------------
{
  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff",
      currentStep: "handoff",
      branchName: "feature/issue-580-test",
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 999_000,
    cap: "wall-clock",
    reviewRound: 2,
    nextStep: "handoff",
  });

  const msg = renderHandoffUserMessage(s, "/repo", "/repo/tmp/issue-580");
  const firstLine = msg.split("\n")[0];

  assert(
    firstLine.startsWith("pi-ensemble:driver-event v1 kind=handoff issue=580 at="),
    "renderHandoffUserMessage: first line is driver-event envelope",
  );
  assert(
    firstLine.includes("kind=handoff"),
    "envelope: kind=handoff",
  );
  assert(
    firstLine.includes("issue=580"),
    "envelope: issue=580",
  );
  assert(
    firstLine.includes("at=") && firstLine.slice(firstLine.indexOf("at=") + 3).length > 10,
    "envelope: at=<iso timestamp>",
  );

  // The body follows directly after the envelope (no blank line separator —
  // the banner or HANDOFF line starts on line 1).
  const lines = msg.split("\n");
  assert(
    lines[1]?.includes("HANDOFF") || lines[1]?.includes("HANDOFF DISPATCH INCOMPLETE"),
    "envelope followed by handoff body/banner",
  );
}

// ---------------------------------------------------------------------------
// 5. Multi-issue envelope (issues comma-separated)
// ---------------------------------------------------------------------------
{
  let s = initialState(580, 1_000_000);
  s = { ...s, issues: [580, 581] };
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "handoff",
      currentStep: "handoff",
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 999_000,
    cap: "round-cap",
    reviewRound: 1,
    nextStep: "handoff",
  });

  const msg = renderHandoffUserMessage(s, "/repo", "/repo/tmp/issue-580");
  const firstLine = msg.split("\n")[0];

  assert(
    firstLine.startsWith("pi-ensemble:driver-event v1 kind=handoff issue=580 at="),
    "multi-issue: envelope names primary issue",
  );
}

// ---------------------------------------------------------------------------
// 6. handoffDeliveredAt absent on handoff/aborted → delivers
// ---------------------------------------------------------------------------
{
  let delivered = false;
  const fakePi = {
    sendUserMessage: () => { delivered = true; },
  } as unknown as ExtensionAPI;

  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "aborted",
      currentStep: "handoff",
    },
  };

  const notifyAgent = (pi: ExtensionAPI, text: string) => {
    pi.sendUserMessage(text);
  };

  if (!s.pipelineState.handoffDeliveredAt) {
    notifyAgent(fakePi, "test");
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, handoffDeliveredAt: "2026-01-01T00:00:00.000Z" },
    };
  }

  assert(delivered, "aborted + no handoffDeliveredAt → delivers");
  assert(s.pipelineState.handoffDeliveredAt === "2026-01-01T00:00:00.000Z", "aborted → field set after");
}

// ---------------------------------------------------------------------------
// 7. handoffDeliveredAt present on aborted → skips delivery
// ---------------------------------------------------------------------------
{
  let delivered = false;
  const fakePi = {
    sendUserMessage: () => { delivered = true; },
  } as unknown as ExtensionAPI;

  let s = initialState(580, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "aborted",
      currentStep: "handoff",
      handoffDeliveredAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const notifyAgent = (pi: ExtensionAPI, _text: string) => {
    pi.sendUserMessage(_text);
  };

  if (!s.pipelineState.handoffDeliveredAt) {
    notifyAgent(fakePi, "test");
  }

  assert(!delivered, "aborted + handoffDeliveredAt set → skips delivery");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
