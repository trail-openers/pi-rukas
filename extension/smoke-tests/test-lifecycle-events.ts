#!/usr/bin/env bun
/**
 * Pure unit test for lifecycle scrollback events (#118, migrated to the
 * entry-API pair in #708):
 *  - formatLine produces the expected shapes (dispatched/completed/failed)
 *  - tokens/elapsed shown only when present
 *  - exit code shown only on failed
 *  - emitX functions push exactly one appendEntry(CUSTOM_TYPE, details) call
 *    (the API-pair contract: ZERO sendMessage calls, one appendEntry per emit)
 *  - PI_ENSEMBLE_QUIET_LIFECYCLE=1 short-circuits before any appendEntry
 *  - attach() registers exactly one EntryRenderer for "ensemble:lifecycle"
 *  - the registered renderer, invoked with all detail shapes, always returns
 *    a Text whose rendered first line equals
 *    applyTheme(details, formatLine(details), theme) — byte-identical
 *    scrollback lines under a deterministic fake theme
 *  - when registerEntryRenderer is unavailable, attach() degrades to a
 *    silent no-op and subsequent emits make ZERO appendEntry calls
 *
 * No Pi spawns. The transport is exercised by attaching a fake ExtensionAPI
 * that records appendEntry / registerEntryRenderer / sendMessage calls.
 */

import {
  type LifecycleDetails,
  attach,
  detach,
  emitCompleted,
  emitDispatched,
  emitFailed,
  emitSteered,
  emitStepCompleted,
  emitStepFailed,
  emitStepRetry,
  emitStepStarted,
  formatLine,
  renderLifecycleEntryLine,
} from "../src/lifecycle-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface AppendedEntry {
  customType: string;
  data: unknown;
}

type EntryRenderFn = (
  entry: { customType: string; data?: unknown },
  options: { expanded: boolean },
  theme: { fg: (style: string, text: string) => string },
) => unknown;

function fakePi(opts: { withEntryApi?: boolean } = {}): {
  entries: AppendedEntry[];
  sentMessages: unknown[];
  renderers: Array<{ customType: string; renderer: EntryRenderFn }>;
  pi: Parameters<typeof attach>[0];
} {
  const entries: AppendedEntry[] = [];
  const sentMessages: unknown[] = [];
  const renderers: Array<{ customType: string; renderer: EntryRenderFn }> = [];
  const withEntryApi = opts.withEntryApi ?? true;
  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
    registerEntryRenderer: (customType: string, renderer: EntryRenderFn) => {
      renderers.push({ customType, renderer });
    },
    sendMessage: (m: unknown) => {
      sentMessages.push(m);
    },
  } as unknown as Parameters<typeof attach>[0];
  if (!withEntryApi) {
    // Older Pi without the entry-API pair: strip both methods so the
    // typeof guards in attach()/emit() see them as unavailable.
    delete (pi as unknown as { appendEntry?: unknown }).appendEntry;
    delete (pi as unknown as { registerEntryRenderer?: unknown }).registerEntryRenderer;
  }
  return { entries, sentMessages, renderers, pi };
}

/** Deterministic fake theme: records the style applied to each fg call. */
function fakeTheme(): { theme: { fg: (style: string, text: string) => string }; styles: string[] } {
  const styles: string[] = [];
  const theme = {
    fg: (style: string, text: string) => {
      styles.push(style);
      return text;
    },
  };
  return { theme, styles };
}

// All 9 LifecycleDetails shapes (one per kind) — the full matrix the
// renderer must handle, plus the synthetic entries built from them.
const ALL_SHAPES: LifecycleDetails[] = [
  { kind: "dispatched", jobId: "df8a-7r", label: "developer", role: "developer" },
  {
    kind: "completed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    totalTokens: 14300,
  },
  {
    kind: "failed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    exitCode: 1,
  },
  {
    kind: "errored",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 3000,
  },
  {
    kind: "steered",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    steerMessage: "please continue",
  },
  {
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
  },
  {
    kind: "step-completed",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    elapsedMs: 45000,
    totalTokens: 8000,
    round: 2,
    recovered: true,
  },
  {
    kind: "step-failed",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    elapsedMs: 45000,
    reason: "cap-hit: ci-retry",
  },
  {
    kind: "step-retry",
    jobId: "lens-review",
    label: "lens-review",
    role: "lens-review",
    stepNumber: 7,
    stepTotal: 9,
    round: 2,
    reason: "subagent ABORT",
  },
];

const KINDS = ALL_SHAPES.map((d) => d.kind);

// 1. formatLine — dispatched shape.
{
  const text = formatLine({
    kind: "dispatched",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
  });
  assert(
    text.startsWith("▸ ensemble: dispatched"),
    "dispatched line uses ▸ ensemble: dispatched prefix",
  );
  assert(text.includes("developer"), "dispatched line includes label");
  assert(text.includes("df8a-7r"), "dispatched line includes jobId");
  assert(!text.includes("ms"), "dispatched line has no elapsed");
  assert(!text.includes("token"), "dispatched line has no token count");
}

// 2. formatLine — completed with tokens + elapsed.
{
  const text = formatLine({
    kind: "completed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    totalTokens: 14300,
  });
  assert(text.includes("✓"), "completed line uses ✓");
  assert(text.includes("developer"), "completed line includes label");
  assert(text.includes("2m31s"), "completed line includes formatted elapsed");
  // formatTokens rounds 14300 → "14k" (≥10k uses no decimals — see progress.ts).
  assert(text.includes("14k tokens"), "completed line includes formatted token count");
  assert(text.includes("finished"), "completed line says finished");
}

// 3. formatLine — completed with zero tokens drops the token suffix.
{
  const text = formatLine({
    kind: "completed",
    jobId: "x",
    label: "ops",
    role: "ops",
    elapsedMs: 1000,
    totalTokens: 0,
  });
  assert(!text.includes("token"), "zero tokens omitted from completed line");
}

// 4. formatLine — failed with exit code + elapsed.
{
  const text = formatLine({
    kind: "failed",
    jobId: "df8a-7r",
    label: "developer",
    role: "developer",
    elapsedMs: 151000,
    exitCode: 1,
  });
  assert(text.includes("✗"), "failed line uses ✗");
  assert(text.includes("failed"), "failed line says failed");
  assert(text.includes("2m31s"), "failed line includes elapsed");
  assert(text.includes("exit 1"), "failed line includes exit code");
  assert(text.includes("see report"), "failed line points at the report");
}

// 5. formatLine — failed without exit code (work threw before child started).
{
  const text = formatLine({
    kind: "failed",
    jobId: "x",
    label: "ops",
    role: "ops",
    elapsedMs: 1000,
  });
  assert(!text.includes("exit "), "no exit code when undefined");
}

// 6. emitX pushes appendEntry(CUSTOM_TYPE, details) — one per emit, ZERO
//    sendMessage calls (the #708 API-pair contract).
{
  const { entries, sentMessages, pi } = fakePi();
  attach(pi);
  emitDispatched("job-1", "developer", "developer");
  emitCompleted("job-1", "developer", "developer", 8000, 5000);
  emitFailed("job-2", "ops", "ops", 12000, 1);
  emitSteered("job-2", "ops", "ops", "carry on", "pm-tool");
  emitStepStarted("adversarial", 5, 9);
  emitStepCompleted("adversarial", 5, 9, 1000, 100);
  emitStepFailed("adversarial", 5, 9, 1000, "cap-hit: ci-retry");
  emitStepRetry("lens-review", 7, 9, 2, "subagent ABORT");
  assert(entries.length === 8, "eight emits → eight appendEntry calls (one per emit)");
  assert(entries.every((e) => e.customType === "ensemble:lifecycle"), "every entry uses ensemble:lifecycle customType");
  assert(sentMessages.length === 0, "zero sendMessage calls after the migration");
  const kinds = entries.map((e) => (e.data as LifecycleDetails).kind);
  assert(
    JSON.stringify(kinds) ===
      JSON.stringify([
        "dispatched",
        "completed",
        "failed",
        "steered",
        "step-started",
        "step-completed",
        "step-failed",
        "step-retry",
      ]),
    "entry details payload carries the full structured LifecycleDetails (kind order preserved)",
  );
  const completed = entries[1]?.data as LifecycleDetails;
  assert(completed.elapsedMs === 8000, "details payload retains elapsedMs (not pre-formatted)");
  const steered = entries[3]?.data as LifecycleDetails;
  assert(steered.steerMessage === "carry on", "details payload retains steerMessage");
  detach();
}

// 7. PI_ENSEMBLE_QUIET_LIFECYCLE=1 short-circuits before any appendEntry call.
{
  const { entries, sentMessages, pi } = fakePi();
  attach(pi);
  process.env.PI_ENSEMBLE_QUIET_LIFECYCLE = "1";
  emitDispatched("muted", "developer", "developer");
  emitCompleted("muted", "developer", "developer", 1000, 100);
  assert(entries.length === 0, "quiet env var prevents appendEntry");
  assert(sentMessages.length === 0, "quiet env var prevents sendMessage");
  process.env.PI_ENSEMBLE_QUIET_LIFECYCLE = undefined;
  emitDispatched("audible", "developer", "developer");
  assert(entries.length === 1, "emits resume when env var unset");
  detach();
}

// 8. Without attach, emit is a no-op (don't throw).
{
  detach();
  let threw = false;
  try {
    emitDispatched("orphan", "ops", "ops");
  } catch {
    threw = true;
  }
  assert(!threw, "emit before attach does not throw");
}

// 9. attach() registers exactly one EntryRenderer for "ensemble:lifecycle".
{
  const { renderers, pi } = fakePi();
  attach(pi);
  assert(renderers.length === 1, "attach registers exactly one entry renderer");
  assert(
    renderers[0]?.customType === "ensemble:lifecycle",
    "the renderer is registered for the ensemble:lifecycle customType",
  );
  detach();
}

// 10. The registered renderer, invoked with all 9 detail shapes, always
//     returns a non-undefined component (guarding the
//     CustomEntryComponent.hasContent()==false silent-drop failure mode)
//     and produces a Text whose content is byte-identical to
//     applyTheme(details, formatLine(details), theme).
{
  const { renderers, pi } = fakePi();
  attach(pi);
  const renderer = renderers[0]?.renderer;
  assert(typeof renderer === "function", "attach captured a renderer fn");
  let allText = true;
  let allNonUndefined = true;
  let byteIdentical = true;
  const expectedStyles: Record<string, string> = {
    dispatched: "dim",
    completed: "success",
    failed: "error",
    errored: "error",
    steered: "warning",
    "step-started": "dim",
    "step-completed": "success",
    "step-failed": "error",
    "step-retry": "warning",
  };
  if (renderer) {
    for (const details of ALL_SHAPES) {
      const { theme, styles } = fakeTheme();
      const entry = { customType: "ensemble:lifecycle", data: details } as unknown as Parameters<EntryRenderFn>[0];
      const comp = renderer(entry, { expanded: false }, theme);
      if (comp === undefined) {
        allNonUndefined = false;
        continue;
      }
      // Extract the text from the Text component via render(9999) — the
      // renderer uses new Text(styled, 0, 0) (zero padding), so the first
      // rendered line IS the styled content (padded to width with spaces).
      const renderFn = (comp as unknown as { render?: (w: number) => string[] }).render;
      if (typeof renderFn !== "function") {
        allText = false;
        continue;
      }
      const lines = renderFn.call(comp, 9999);
      const firstLine = (lines[0] ?? "").trimEnd();
      const expected = renderLifecycleEntryLine(details, theme);
      if (firstLine !== expected) {
        byteIdentical = false;
        console.error(`  byte-identity mismatch for ${details.kind}:\n    got:      ${JSON.stringify(firstLine)}\n    expected: ${JSON.stringify(expected)}`);
      }
      // The fake theme records the style applied — assert it matches the
      // kind's expected theme.fg style (the applyTheme switch).
      if (styles[0] !== expectedStyles[details.kind]) {
        console.error(`  style mismatch for ${details.kind}: got ${styles[0]}, expected ${expectedStyles[details.kind]}`);
        byteIdentical = false;
      }
    }
  }
  assert(allNonUndefined, "renderer returns a component (never undefined) for all 9 detail shapes");
  assert(allText, "renderer returns a Text component (with render()) for all 9 detail shapes");
  assert(byteIdentical, "renderer output is byte-identical to applyTheme(details, formatLine(details), theme) for all 9 kinds");
  detach();
}

// 11. Renderer invoked with a synthetic CustomEntry whose data is undefined
//     (appendEntry<T>(customType, data?) leaves data optional) must not throw
//     and must still return a component (no silent drop).
{
  const { renderers, pi } = fakePi();
  attach(pi);
  const renderer = renderers[0]?.renderer;
  let ok = true;
  if (renderer) {
    try {
      const { theme } = fakeTheme();
      const comp = renderer({ customType: "ensemble:lifecycle", data: undefined } as unknown as Parameters<EntryRenderFn>[0], { expanded: false }, theme);
      if (comp === undefined) ok = false;
    } catch {
      ok = false;
    }
  } else {
    ok = false;
  }
  assert(ok, "renderer with undefined data returns a component without throwing");
  detach();
}

// 12. Graceful degradation: older Pi without registerEntryRenderer —
//     attach() does not throw, and subsequent emits make ZERO appendEntry
//     calls (no entry persisted when nothing could render it).
{
  const { entries, sentMessages, renderers, pi } = fakePi({ withEntryApi: false });
  let threw = false;
  try {
    attach(pi);
  } catch {
    threw = true;
  }
  assert(!threw, "attach with unavailable entry API does not throw");
  assert(renderers.length === 0, "no renderer registered when the entry API is unavailable");
  emitDispatched("degraded", "developer", "developer");
  emitCompleted("degraded", "developer", "developer", 1000, 100);
  assert(entries.length === 0, "degraded attach → zero appendEntry calls on emit");
  assert(sentMessages.length === 0, "degraded attach → zero sendMessage calls on emit");
  detach();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
