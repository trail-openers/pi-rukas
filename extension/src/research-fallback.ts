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

/** The three wigolo surfaces the explore recipe covers (research = deep). */
export type WigoloSurface = "search" | "fetch" | "research";

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
 * Classify the raw `parallel-outcome:` marker text (last occurrence wins,
 * via the shared marker reader — the #408 doctrine). The classification is
 * ANCHORED, not keyword-broad: credit on the verbatim string, everything
 * else on a narrow token set, so prose that merely mentions "credit" in a
 * research summary cannot re-route the driver.
 */
export function classifyParallelOutcome(rawText: string): ParallelOutcome {
  if (typeof rawText !== "string" || rawText.trim() === "") return "unparseable";
  // The `parallel-outcome:` marker, last occurrence wins (readMarker,
  // #408) — a musing earlier in the reply must not be read as the outcome.
  const marker = readMarker(rawText, "parallel-outcome", new RegExp("([\\w][\\w-]*)", "i"));
  // The bare verbatim credit string is the documented anchor (the live case
  // in outputs/research-knockoutez-wigolo-…md): it maps to credit-exhausted
  // even when the child never emitted the marker.
  if (marker && marker.toLowerCase().includes("credit")) return "credit-exhausted";
  const t = rawText.toLowerCase();
  if (t.includes("insufficient credit")) return "credit-exhausted";
  if (t.includes("blocked_by_challenge") || t.includes("network-failed") || t.includes("network"))
    return "network-failed";
  if (t.includes("auth-missing") || t.includes("401")) return "auth-missing";
  if (t.includes("empty-result")) return "empty-result";
  if (marker) {
    const m = marker.toLowerCase();
    if (m.includes("credit")) return "credit-exhausted";
    if (m.includes("network") || m.includes("block")) return "network-failed";
    if (m.includes("auth")) return "auth-missing";
    if (m.includes("empty")) return "empty-result";
    if (m.includes("success")) return "success";
    if (m.includes("unparseable")) return "unparseable";
  }
  return "unparseable";
}

/**
 * Select the fallback action for a failed angle.
 *
 * - `success` / `empty-result` → keep Parallel (the fallback exists for
 *   FAILURES; an empty answer is an answer).
 * - `credit-exhausted` / `auth-missing` / `network-failed` → fall back,
 *   UNLESS the flag is `0` (host-side off — the driver then never
 *   re-dispatches) or the surface has no wigolo equivalent (monitor /
 *   findall / enrichment — `no-fallback-available`, the honest answer).
 * - `unparseable` → keep Parallel (never success, never a trigger).
 */
export function selectFallback(
  outcome: ParallelOutcome,
  surface: WigoloSurface | "monitor" | "findall" | "enrichment",
  fallbackEnabled: boolean,
): FallbackDecision {
  if (!fallbackEnabled) return "keep-parallel";
  if (outcome === "success" || outcome === "empty-result" || outcome === "unparseable")
    return "keep-parallel";
  if (surface === "monitor" || surface === "findall" || surface === "enrichment")
    return "no-fallback-available";
  return "fall-back-to-wigolo";
}

/**
 * Map an angle name to its wigolo surface (#773 spec): web-current /
 * adoption-signals / alternatives → search, docs-depth → fetch, deep tier
 * → research. Unknown angles default to search (the cheapest surface).
 */
export function surfaceForAngle(angleName: string): WigoloSurface {
  const n = angleName.toLowerCase();
  if (n.includes("docs") || n.includes("fetch")) return "fetch";
  if (n.includes("deep") || n.includes("research")) return "research";
  return "search";
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
  reason: ParallelOutcome | string,
): string {
  const cmds =
    surface === "fetch"
      ? `wigolo fetch <url> --json 2>/dev/null`
      : surface === "research"
        ? `wigolo research "question" --depth standard --json 2>/dev/null`
        : `wigolo search "query" --json 2>/dev/null`;
  return [
    `RE-RESEARCH (angle: ${angle.name}) — Parallel failed (classified: ${reason}); use the WIGOLO CLI for this angle only.`,
    "",
    "wigolo is a keyless local web-intelligence CLI already in the sandbox. It mirrors this angle with:",
    `  ${cmds}`,
    surface === "research"
      ? "With WIGOLO_LLM_API_KEY set, `research` returns a SYNTHESIZED brief; without it, a RAW brief. State which one you used."
      : "",
    "",
    "An empty Parallel result is NOT a failure — this re-dispatch happened because the Parallel call itself FAILED, not because it returned nothing.",
    "monitor / findall / enrichment have NO wigolo equivalent — if this angle required one, report a gap instead.",
    "",
    "Do the original task below. When finished, end your reply with the line `backend: wigolo`.",
    "",
    angle.prompt,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
