/**
 * Spawn support helpers for `spawnSpecialist` — per-role timeout resolution,
 * the child stderr-tail budget, the runtime cwd hint prepended to kickoff
 * prompts, per-child transcript paths, run-id generation, and pi-binary
 * invocation resolution. Each function here is self-contained and called
 * once (or a handful of times) from spawn.ts; factored out to keep the
 * `spawnSpecialist` + `collapseEvents` file under the module-size guideline
 * (AGENTS.md §12, #171).
 */

import os from "node:os";
import path from "node:path";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { type RoleName, isRoleName } from "./roles.ts";

// Hard wall-clock cap on subagent runtime (issue #114). PR5 splits the old
// single 30-min global into per-role defaults. #296 raised them: the PR5
// values (15 min lens/adversarial, 10 min ops) sat BELOW the legitimate
// runtime of thinking-heavy models — a single xhigh-thinking review turn
// streams 10-17 min, so healthy children were SIGTERM'd mid-work (lantern
// work-state 592/595/596: exit-143 kills at exactly the 15-min/3-min
// budgets). The wall-clock cap is now a generous OUTER bound; the
// inactivity watchdog below is the primary hang detector. Operators tune
// via env; PM cannot influence (no tool schema exposes timeout — #114).
//
// Per-role overrides via PI_ENSEMBLE_SPAWN_TIMEOUT_MS_<ROLE_UPPER> (with
// hyphens as underscores: PI_ENSEMBLE_SPAWN_TIMEOUT_MS_CODE_REVIEW_SPECIALIST).
// The umbrella PI_ENSEMBLE_SPAWN_TIMEOUT_MS is preserved as a global
// override (back-compat for callers who set it before PR5).
const ROLE_TIMEOUT_DEFAULTS_MS: Record<RoleName, number> = {
  // 90 min — empirical #553 evidence: developer was 43 min into substantive
  // multi-defect work when the old 30-min cap SIGTERM'd it.
  developer: 90 * 60_000,
  // 45 min — lens child reviewing a diff; xhigh-thinking turns alone run
  // 10-17 min, and a review is several turns.
  "code-review-specialist": 45 * 60_000,
  // 45 min — adversarial-developer's review/fix round inside the 3-round loop.
  "adversarial-developer": 45 * 60_000,
  // 30 min — read-heavy, bounded by vipune/codebase-memory query latency.
  explore: 30 * 60_000,
  // 30 min — mechanical (gh / git invocations) but includes CI watches and
  // recovery/handoff dispatches that deserve generous budgets (#296).
  ops: 30 * 60_000,
  // 30 min — unchanged. Parent process spawn (rare) — keeps prior behaviour.
  "project-manager": 30 * 60_000,
};

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
 * Resolve a per-role spawn timeout. Reads env per-call so tests can
 * override after module init. Precedence (highest to lowest):
 *   1. PI_ENSEMBLE_SPAWN_TIMEOUT_MS_<ROLE_UPPER> per-role env
 *   2. PI_ENSEMBLE_SPAWN_TIMEOUT_MS umbrella env (PR4-and-earlier semantics)
 *   3. ROLE_TIMEOUT_DEFAULTS_MS[role] per-role default
 *   4. 30 * 60_000 hard fallback (unknown role)
 */
export function roleTimeoutMs(role: string): number {
  const envKey = `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_${role.toUpperCase().replaceAll("-", "_")}`;
  const envRole = Number(process.env[envKey]);
  if (Number.isFinite(envRole) && envRole > 0) return envRole;
  const envUmbrella = Number(process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS);
  if (Number.isFinite(envUmbrella) && envUmbrella > 0) return envUmbrella;
  if (isRoleName(role)) return ROLE_TIMEOUT_DEFAULTS_MS[role];
  return 30 * 60_000;
}

// Back-compat export for callers that referenced the constant directly.
// Now resolved per-call via roleTimeoutMs (PR5), so the static value is
// always the unknown-role fallback. Most call sites should use
// roleTimeoutMs(spec.role) instead.
export const DEFAULT_SPAWN_TIMEOUT_MS = 30 * 60_000;

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
