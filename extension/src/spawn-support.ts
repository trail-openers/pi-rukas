/**
 * Spawn support helpers for `spawnSpecialist` — the wall-clock backstop and
 * inactivity watchdog, the child stderr-tail budget, the runtime cwd hint
 * prepended to kickoff prompts, per-child transcript paths, run-id generation,
 * and pi-binary invocation resolution. Each function here is self-contained
 * and called once (or a handful of times) from spawn.ts; factored out to keep
 * the `spawnSpecialist` + `collapseEvents` file under the module-size
 * guideline (AGENTS.md §12, #171).
 */

import os from "node:os";
import path from "node:path";
import type { ResolvedModelChoice } from "./models.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { excludeToolsFor } from "./role-tools.ts";
import {
  applyUserExtension,
  discoverInstalledExtensions,
  piEnsembleExtensionPath,
} from "./spawn-extension-forward.ts";
import type { DispatchUsage } from "./types.ts";

/**
 * Runaway backstop — the outer bound on any child's wall clock.
 *
 * This replaced a table of six per-role numbers. They were raised twice —
 * #296 (the lens and ops caps sat below a single xhigh-thinking turn) and
 * #553 (a developer was 43 min into substantive work when the 30-min cap
 * SIGTERM'd it) — and both times the finding was identical: the number was
 * too small for a HEALTHY child. That is the signature of a bad metric rather
 * than a mistuned one. Provider speed varies by an order of magnitude, so no
 * wall-clock number means the same thing on two different models, and the
 * table had already drifted out of sync with its own documentation (the
 * troubleshooting matrix still claimed 15 min for lenses that were set to 45).
 *
 * Liveness is the model-independent signal, and `inactivityTimeoutMs` below is
 * the real hang detector. This constant exists only to stop a runaway loop —
 * a child that keeps emitting events while making no progress never trips
 * liveness — so it sits deliberately far above any legitimate runtime rather
 * than being tuned to one.
 *
 * Operator/CI override: PI_ENSEMBLE_SPAWN_TIMEOUT_MS. PM cannot influence it
 * (no tool schema exposes a timeout — #114).
 */
export const SPAWN_BACKSTOP_MS = 2 * 60 * 60_000;

/**
 * Inactivity watchdog (#296): kill a child only when it has produced NO
 * stdout at all for this long — the empirical signature of a genuine hang
 * (provider stream stalled through every retry layer, or a wedged local
 * process). Healthy children emit an event at least every turn/tool
 * boundary; the longest healthy silent gap measured in production
 * transcripts is ~15 min (a long bash execution), so 25 min gives margin
 * while still detecting true hangs long before the wall-clock cap.
 * Override: PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS (0 disables).
 */
export function inactivityTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 25 * 60_000;
}

/**
 * The wall-clock backstop for any child, read per-call so tests can override
 * after module init. One knob, one meaning, no role dimension.
 */
export function spawnBackstopMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : SPAWN_BACKSTOP_MS;
}

// Per-spawn stderr tail cap. The full byte budget is enough to retain the
// last ~10-20 turns of telemetry from a chatty child — plenty for failure
// debugging — without unbounded ConsString growth on long runs.
export const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Build the runtime cwd hint prepended to the subagent's kickoff prompt.
 *
 * When PM dispatches with `cwd: <abs path>`, the subagent's shell already
 * lives there — but weak local models (Qwen3-class, 30-40B) skim past the
 * generic "do not cd" doctrine in the system prompt. A concrete absolute
 * path in the runtime prompt is a much harder cue to ignore. See PR #192
 * + arxiv 2505.18135 on the measured strength of runtime context engineering
 * vs. system-prompt-only steering for weak models.
 *
 * Exported for unit testing — the live spawn smoke is slow.
 */
export function buildCwdHint(cwd: string | undefined): string {
  if (!cwd) return "";
  return `[runtime context: your shell starts in ${cwd}. Do NOT 'cd' to any worktree path — you are already there. If you genuinely need to operate on a different directory, use the tool's flag (\`git -C <path>\`, \`cargo --manifest-path <path>\`, \`npm --prefix <path>\`) — never \`cd && X\`, which prompts the user and caches as an exact-hash entry that never re-matches.]\n\n`;
}

/**
 * Where per-child transcripts live. One file per spawned specialist, grouped
 * by date so old runs are easy to prune. The user can `pi --session <path>`
 * to replay or just open the JSON.
 */
export function transcriptPathFor(role: string, runId: string, seq?: number, tag?: string): string {
  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const parts = [role];
  if (tag) parts.push(tag);
  if (seq != null) parts.push(String(seq));
  return path.join(piAgentDir, "ensemble-runs", date, `${runId}-${parts.join("-")}.json`);
}

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the pi binary. When this code runs inside a pi process (the
 * extension is loaded), argv[1] is Pi's CLI entry script and we re-invoke the
 * SAME pi build (avoids PATH ambiguity, matches Pi's own subagent example).
 *
 * When this code runs outside Pi (smoke tests under `bun run`), argv[1] is the
 * test file and we'd recursively spawn ourselves — guard against that by only
 * trusting argv[1] when it looks like a Pi CLI entrypoint.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const looksLikePiCli =
    currentScript &&
    !currentScript.startsWith("/$bunfs/") &&
    /pi-coding-agent.*\/(dist\/)?cli\.(js|cjs|mjs)$/i.test(currentScript);
  if (looksLikePiCli) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  // Fall back to `pi` on PATH — works for smoke tests and any other context
  // where argv[1] isn't a Pi CLI script.
  return { command: "pi", args };
}

/**
 * Is the child about to retry this failure itself?
 *
 * Pi's own retry is in-process, so it keeps the child's accumulated context and
 * resumes the work. The driver's retry re-dispatches from scratch. Whenever
 * both are available the child's is strictly better, so the parent's only job
 * is to stay out of its way — which means not closing stdin.
 *
 * Read defensively: a Pi version that does not stamp the flag simply yields
 * `false`, restoring the previous behaviour exactly.
 */
export function willRetryAfter(event: PiJsonEvent): boolean {
  return event.willRetry === true;
}

/**
 * Correct a result's counts against what we actually watched go past.
 *
 * `agent_end.messages` is NOT the session — it is the messages produced since
 * the previous `agent_end`, and Pi emits one per in-process retry boundary. So
 * the last `agent_end` holds only the final segment. Measured on four real
 * children: `rust-slack` recovered from five 429s and its last segment was
 * exactly 29 messages — the "29 turns" we reported, against 57 assistant turns
 * on disk. The three that DIED ended on the error itself, so their segment was
 * the lone error stub: `1 turns · (no output)` for a child that had made 41
 * tool calls and fetched 136k characters.
 *
 * The running state has no such gap: `ingestEvent` counts every `message_end`
 * across every segment. Prefer it wherever it saw more — which is exactly the
 * case where the segment under-reports. Never prefer it downward: a lower count
 * would mean we missed events, and the replay is then the better source.
 */
export function reconcileObservedCounts(
  result: {
    usage?: DispatchUsage;
    toolUses: unknown[];
    observedToolCalls?: number;
  },
  observed: { usage: DispatchUsage; toolUses: number },
): void {
  if (observed.usage.turns > (result.usage?.turns ?? 0)) {
    result.usage = { ...observed.usage };
  }
  // Tool calls are only ever counted live; the replay carries no equivalent.
  if (result.toolUses.length === 0 && observed.toolUses > 0) {
    result.observedToolCalls = observed.toolUses;
  }
}

/** Injection point a test should have used, per role. */
const INJECTION_NAMES: Record<string, string> = {
  "code-review-specialist": "lensReviewFn",
  "adversarial-developer": "adversarialLoopFn",
};

/**
 * Test-only guard against an accidental live spawn in an offline smoke test.
 *
 * Throws naming the role and the injection point that should have been used.
 * Bypassed by PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1, which the `*-live.ts` tests set.
 * Production never sets the forbidding flag, so this is a no-op there.
 */
export function assertLiveSpawnAllowed(role: string): void {
  if (
    process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN !== "1" ||
    process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN === "1"
  ) {
    return;
  }
  const injectionName = INJECTION_NAMES[role] ?? "dispatchFn";
  throw new Error(
    `FORBID_LIVE_SPAWN: spawnSpecialist called for role "${role}" without injection. Set PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 for live tests, or inject ${injectionName} in DriverContext.`,
  );
}

const CHILD_ARGS_BASE = ["--mode", "rpc", "--no-extensions"] as const;

/**
 * Build the complete child argument list for spawning a subagent Pi process.
 * Used by `spawnSpecialist` and exported for smoke-test verification.
 *
 * Argument order is load-bearing:
 *   - `--provider` must precede `--model` so Pi disambiguates against the
 *     provider catalog (custom providers need explicit provider IDs).
 *   - Extension `--extension` flags are appended after model flags so Pi
 *     resolves the model before extensions can override it.
 */
export function buildChildArgs(
  role: string,
  tmpPromptFile: string,
  transcriptPath: string,
  modelChoice: ResolvedModelChoice,
  subagentGuardEnabled: boolean,
  extraArgs?: string[],
): string[] {
  const args: string[] = [...CHILD_ARGS_BASE];
  // `--mode rpc` keeps stdin open for JSON command injection
  // ({type:"prompt"|"steer"|"abort"|"follow_up"}); this is the foundation
  // for dispatch_steer (#152) and all async push-callback flows.
  args.push("--session", transcriptPath);
  args.push("--append-system-prompt", tmpPromptFile);
  // `--exclude-tools` requires Pi >= 0.83.0; with pin at ~0.82.0 the
  // flag is accepted by 0.82.x but was unknown in 0.75.x (caused
  // immediate child exit). Verified by test-role-tools.ts smoke test.
  const excludedTools = excludeToolsFor(role);
  if (excludedTools) {
    args.push("--exclude-tools", excludedTools);
  }
  if (modelChoice.provider) {
    args.push("--provider", modelChoice.provider);
  }
  if (modelChoice.model) {
    args.push("--model", modelChoice.model);
  }
  for (const ext of discoverInstalledExtensions(role)) {
    args.push("--extension", ext);
  }
  applyUserExtension(args, role);
  if (subagentGuardEnabled) {
    const ensemblePath = piEnsembleExtensionPath();
    if (ensemblePath) {
      args.push("--extension", ensemblePath);
    }
  }
  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}
