/**
 * Type-only shapes for the child-Pi spawn contract: `spawnSpecialist`'s
 * options object and the `--mode rpc` JSONL event/message shapes it parses.
 *
 * Zero runtime logic lives here — pure `interface` declarations, erased at
 * compile time. Split out of spawn.ts (#171) so the load-bearing spawn +
 * parsing logic isn't buried under type definitions. The Pi event shape
 * itself (Pi 0.75.3) is pinned and verified by `test-pi-shape-live.ts` (#7);
 * see spawn.ts's module header for the full contract description.
 */

import type { RunningState } from "./progress.ts";

export interface SpawnOptions {
  /**
   * Hard cap on child wall-clock. Default 30 minutes (DEFAULT_SPAWN_TIMEOUT_MS).
   * Critical: without a cap, a stalled model API call (Cerebras / Copilot /
   * Anthropic — any provider) leaves the child hung forever and the parent's
   * `await once(child, "exit")` never resolves.
   *
   * NOT a PM-callable knob. No agent-facing dispatch tool schema exposes
   * `timeoutMs` — verified across dispatch_specialist, dispatch_parallel,
   * dispatch_lens_review, adversarial_loop. This field exists for internal
   * callers (currently unused in production) and for smoke tests that
   * deliberately use short timeouts to exercise cancel/timeout paths
   * (e.g. test-cancel.ts uses 2s to assert SIGTERM behaviour).
   *
   * Operator/CI override: `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` env var. Not
   * settable by the agent (PM cannot set env vars at runtime).
   */
  timeoutMs?: number;
  /**
   * Pi's tool-execute AbortSignal — fires when the user hits Esc to cancel
   * the running tool. We listen on this and kill the child with SIGTERM so
   * cancellation actually propagates instead of leaving Pi stuck.
   */
  signal?: AbortSignal;
  /**
   * Group children from the same dispatch_parallel call under a shared id so
   * their session files sort together on disk.
   */
  runId?: string;
  /** Sequence number within a parallel batch (helps disambiguate identical roles). */
  seq?: number;
  /**
   * Extra Pi CLI flags to insert before the positional prompt. Used by
   * specialised dispatchers (e.g. lens review pinning a specific --skill).
   */
  extraArgs?: string[];
  /**
   * Optional tag appended to the transcript filename (e.g. "security",
   * "performance"). Distinguishes children sharing the same role within a
   * single parallel batch.
   */
  tag?: string;
  /**
   * Live-progress callback. Fires every time the child emits a `message_end`
   * event with `role: "assistant"` — i.e. once per turn completion. The
   * snapshot is a defensive copy; safe to mutate downstream.
   */
  onProgress?: (snapshot: RunningState) => void;
  /**
   * Stdin-handle callback (#153). Fires once after the child process has
   * been spawned and its stdio attached, BEFORE the initial prompt is
   * written. Callers use this to register the stdin handle in a registry
   * (e.g., async-jobs's `childHandles` map) so dispatch_steer can write
   * `{ type: "steer", message }` RPC commands later.
   *
   * The handle's lifetime is the child's lifetime. spawnSpecialist closes
   * stdin on agent_end (done-detection) or process exit; downstream code
   * MUST handle EPIPE / closed-stream errors gracefully.
   */
  onStdin?: (stdin: import("node:stream").Writable) => void;
}

// Pi event shape (Pi 0.75.3) — emitted by `--mode rpc` to stdout as JSONL.
// The canonical assembled answer is at agent_end.messages[]; usage stats
// come from message_end.message.usage on assistant messages.
export interface PiContentBlock {
  type: "text" | "thinking" | "toolCall" | string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
export interface PiMessage {
  role: "user" | "assistant";
  content?: PiContentBlock[];
  toolResults?: unknown[];
  usage?: PiUsage;
  model?: string;
  provider?: string;
  api?: string;
  stopReason?: string;
  /**
   * Set by pi-ai providers when a request fails (timeout, transport, etc) —
   * see openai-completions.js:324-325, anthropic.js:522-523. Pi emits the
   * failed turn as a synthetic assistant message with `stopReason: "error"`,
   * empty content, and this field populated.
   */
  errorMessage?: string;
}
export interface PiJsonEvent {
  type?: string;
  messages?: PiMessage[];
  message?: PiMessage;
}

export interface ExtensionPackageJson {
  name?: string;
  pi?: {
    extensions?: string[];
  };
}
