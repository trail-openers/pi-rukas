/**
 * research-fallback — the wigolo CLI fallback for /research retrieval.
 *
 * Parallel.ai is a hosted API: when its credit runs out the explore child
 * gets `exit 4 "Insufficient credit"` and the angle dies. wigolo
 * (KnockOutEZ/wigolo, npm `wigolo@0.2.1`, AGPL-3.0) is a keyless local CLI
 * that mirrors three of the four Parallel surfaces — search / fetch /
 * research — and serves as the fallback the /research driver re-dispatches
 * with when a Parallel failure is classified as retryable-on-wigolo.
 *
 * The driver (research-driver.ts) reads `PI_ENSEMBLE_RESEARCH_FALLBACK`
 * host-side (unset = on, `0` = off) and tells each explore child which
 * recipe to follow via a single dispatch-time line; it NEVER forwards the
 * flag (the PI_ENSEMBLE_* pattern is blocklisted in bin/pi-rukas), so one
 * static recipe in agents-base/explore.md serves both modes.
 *
 * #773.
 */
import { readMarker } from "./reply-markers.ts";

/**
 * The three wigolo surfaces the explore recipe covers (research = deep).
 * `none` = no wigolo equivalent for this angle (codebase, monitor, findall,
 * enrichment, custom) — the decision is `no-fallback-available`, and the
 * prompt builder is not reached.
 */
export type WigoloSurface = "search" | "fetch" | "research" | "none";

/** The fixed alternation `classifyParallelOutcome` matches the marker with. */
/** The fixed set of class tokens `classifyParallelOutcome` matches. */
const OUTCOME_TOKENS: readonly ParallelOutcome[] = [
  "credit-exhausted",
  "auth-missing",
  "network-failed",
  "empty-result",
  "success",
  "unparseable",
];

function isOutcomeToken(v: string): v is ParallelOutcome {
  return (OUTCOME_TOKENS as readonly string[]).includes(v);
}

/**
 * The classified outcome of the Parallel attempt behind a failed angle.
 *
 * - `success` / `empty-result` — Parallel answered; the fallback must
 *   NEVER fire (an empty result is a valid answer).
 * - `credit-exhausted` — the anchor is the verbatim `Insufficient credit`
 *   from parallel-cli exit 4 (live case: outputs/research-knockoutez-wigolo-…md).
 * - `auth-missing` — SYNTHESISED, verify once against real parallel-cli
 *   output: the 401-class error string when PARALLEL_API_KEY is absent.
 * - `network-failed` — SYNTHESISED, verify once against real parallel-cli
 *   output: the fetch-class failure (DNS/TLS/timeout). ALSO wigolo's own
 *   `blocked_by_challenge` (a bot-challenge it could not clear is a
 *   network failure, never an empty result).
 * - `unparseable` — nothing matched; never treated as success, and never
 *   as a fallback trigger either (the child's marker is the record).
 */
export type ParallelOutcome =
  | "success"
  | "credit-exhausted"
  | "auth-missing"
  | "network-failed"
  | "empty-result"
  | "unparseable";

/** What the driver should do with the failed angle. */
export type FallbackDecision = "keep-parallel" | "fall-back-to-wigolo" | "no-fallback-available";

/**
 * Classify the raw reply of a Parallel attempt. The classification is
 * ANCHORED, not keyword-broad (prose that merely mentions "network latency"
 * or "HTTP 401" must never re-route the driver):
 *
 * 1. the `parallel-outcome:` marker — read with readMarker (last occurrence
 *    wins, #408) using a FIXED alternation of the six class tokens; a marker
 *    outside that set is treated as absent (garbage token ≠ a classification);
 * 2. without a marker, ONLY the two verbatim anchors: `Insufficient credit`
 *    → credit-exhausted, `blocked_by_challenge` → network-failed;
 * 3. nothing → `unparseable` (never success, never a fallback trigger).
 */
export function classifyParallelOutcome(rawText: string): ParallelOutcome {
  if (typeof rawText !== "string" || rawText.trim() === "") return "unparseable";
  const marker = readMarker(
    rawText,
    "parallel-outcome",
    new RegExp(`(${OUTCOME_TOKENS.join("|")})`, "i"),
  );
  if (marker && isOutcomeToken(marker)) return marker;
  const t = rawText.toLowerCase();
  if (t.includes("insufficient credit")) return "credit-exhausted";
  if (t.includes("blocked_by_challenge")) return "network-failed";
  return "unparseable";
}

/**
 * Select the fallback action for a failed angle.
 *
 * - `success` / `empty-result` → keep Parallel (the fallback exists for
 *   FAILURES; an empty answer is an answer).
 * - `credit-exhausted` / `auth-missing` / `network-failed` → fall back,
 *   UNLESS the flag is `0` (host-side off — the driver then never
 *   re-dispatches) or the surface has no wigolo equivalent (`none` for
 *   codebase / monitor / findall / enrichment — `no-fallback-available`,
 *   the honest answer).
 * - `unparseable` → keep Parallel (never success, never a trigger).
 */
export function selectFallback(
  outcome: ParallelOutcome,
  surface: WigoloSurface,
  fallbackEnabled: boolean,
): FallbackDecision {
  if (!fallbackEnabled) return "keep-parallel";
  if (outcome === "success" || outcome === "empty-result" || outcome === "unparseable")
    return "keep-parallel";
  if (surface === "none") return "no-fallback-available";
  return "fall-back-to-wigolo";
}

/**
 * Map an angle name to its wigolo surface (#773 spec, #896). The known web
 * angles map: web-current / adoption-signals / alternatives → search,
 * docs-depth → fetch, deep-dive → research. Custom-N PM angles (the
 * dominant recent pattern) are treated as WEB-CAPABLE and map to search —
 * a custom angle that fails with the web-failure classification gets the
 * one-shot wigolo fallback through the web surface. Everything else — the
 * codebase angle, monitor / findall / enrichment, anything unknown — is
 * `none` (no wigolo equivalent: the decision is `no-fallback-available`,
 * never a re-dispatch of a non-web angle through a web surface).
 */
export function surfaceForAngle(angleName: string): WigoloSurface {
  const n = angleName.toLowerCase();
  if (n === "web-current" || n === "adoption-signals" || n === "adoption-alternatives")
    return "search";
  if (n === "docs-depth") return "fetch";
  if (n === "deep-dive") return "research";
  if (/^custom-\d+$/.test(n)) return "search";
  return "none";
}

/** The dispatch-time line injected next to priorBlock (one static recipe). */
export function researchFallbackLine(enabled: boolean): string {
  return `research fallback: ${enabled ? "enabled" : "disabled"}\n`;
}

/**
 * The re-dispatch prompt for a wigolo-framed angle. The child is told to
 * ignore the Parallel recipe for THIS angle only — it runs the wigolo CLI
 * (keyless, local), reports claims through the same reporter tool, and
 * ends its reply with `backend: wigolo`.
 */
export function wigoloAnglePrompt(
  angle: { name: string; prompt: string },
  surface: WigoloSurface,
  reason: ParallelOutcome,
): string {
  const cmds =
    surface === "fetch"
      ? "wigolo fetch <url> --json 2>/dev/null"
      : surface === "research"
        ? 'wigolo research "question" --depth standard --json 2>/dev/null'
        : 'wigolo search "query" --json 2>/dev/null';
  return [
    `RE-RESEARCH (angle: ${angle.name}) — Parallel failed (classified: ${reason}); use the WIGOLO CLI for this angle only.`,
    "",
    'Preflight the binary FIRST: `command -v wigolo >/dev/null 2>&1 || echo "wigolo not installed"`. If it is missing, DO NOT report `empty-result` — end your reply with `backend: wigolo` and `parallel-outcome: network-failed` with the text "wigolo not installed".',
    "",
    "wigolo is a keyless local web-intelligence CLI in the sandbox. It mirrors this angle with:",
    `  ${cmds}`,
    surface === "research"
      ? "With WIGOLO_LLM_API_KEY set, `research` returns a SYNTHESIZED brief; without it, a RAW brief. State which one you used."
      : "",
    "",
    "An empty Parallel result is NOT a failure — this re-dispatch happened because the Parallel call itself FAILED, not because it returned nothing.",
    "",
    "Do the original task below. When finished, end your reply with the line `backend: wigolo`.",
    "",
    angle.prompt,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
