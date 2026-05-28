/**
 * Per-model behaviour adapters.
 *
 * Different LLM providers / model families emit assistant content with their
 * own quirks. Examples we've observed:
 *
 *   - GLM family from Z.AI (confirmed on zai-glm-4.6, zai-glm-4.7 via Cerebras;
 *     GLM-5.x likely inherits): emits literal `{ type: "text", text: "None" }`
 *     placeholder blocks between tool calls when there is no narration around
 *     them — a Python-repr habit. Joining these blocks naively produces output
 *     like "Setup complete.NoneNoneDone."
 *
 *   - (No quirks observed yet on Claude 4.x, GPT-5.x, Gemini 3.x, Qwen 3.x,
 *     Kimi K2.x, DeepSeek V4.x, Llama 4, Grok 4 — add adapters here as we see
 *     them. Verify current model lineup at build time; LLM training data is
 *     stale.)
 *
 * Rule of thumb: **no model-specific filter goes into a shared function inline.**
 * If a quirk needs handling, declare it on a `ModelAdapter` here and look up
 * via `adapterFor(model, provider)`. Shared code (spawn.ts:collapseEvents)
 * only ever calls adapter methods — never branches on model strings directly.
 *
 * Switching the subagent's model to anything not registered here is safe:
 * the default adapter returns no-op behaviour for every hook. Adding a new
 * model with known quirks is a one-line registry entry, no surgery in shared
 * paths.
 */

export interface ModelAdapter {
  /**
   * Decide whether a `{ type: "text" }` content block is an artifact
   * (placeholder / repr-of-null / format token) that should be dropped before
   * joining text. Default: never drop.
   *
   * Called per text block during transcript collapse and per-turn summary.
   */
  isArtifactText?(text: string): boolean;
}

const DEFAULT_ADAPTER: ModelAdapter = {};

/**
 * GLM family adapter (Z.AI; commonly served via Cerebras Coder).
 *
 * Observed quirk: emits `{ type: "text", text: "None" }` (and sometimes
 * "null") as placeholder blocks between tool calls. Filter these out so
 * joined transcript text reads as natural prose.
 *
 * Confirmed on GLM-4.6 and GLM-4.7. GLM-5.x (released by Z.AI in early 2026)
 * almost certainly inherits the same generation/format conventions, so the
 * detector regex below covers GLM-4 and later. Roll back the detector if a
 * future GLM family changes behavior.
 */
const GLM_FAMILY: ModelAdapter = {
  isArtifactText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === "None" || trimmed === "null" || trimmed === "undefined";
  },
};

/**
 * Family detectors. Order matters — first match wins. Add new families above
 * the catch-all default at the bottom.
 */
const FAMILY_DETECTORS: Array<{
  matches: (m: string, p?: string) => boolean;
  adapter: ModelAdapter;
}> = [
  // GLM family: catches zai-glm-4.6, zai-glm-4.7, zai-glm-4.7-preview,
  // glm-5.1, GLM-5.x... — case-insensitive, matches any GLM model id
  // regardless of separator or version. The artifact behavior is
  // family-wide; widening the regex below 4 (e.g. GLM-3) is fine because
  // the filter only drops literal "None"/"null"/"undefined" trim-text,
  // which are unlikely to appear as legitimate standalone content blocks
  // in any LLM family.
  { matches: (m) => /(?:^|[^a-z])glm(?:[-_\s]?\d|$|[^a-z0-9])/i.test(m), adapter: GLM_FAMILY },
];

/**
 * Resolve the right adapter for a given (model, provider) pair. Both inputs
 * are optional — when missing or unknown, the no-op default is returned.
 *
 * @example
 *   const adapter = adapterFor("zai-glm-4.7", "cerebras");
 *   if (adapter.isArtifactText?.(block.text)) continue; // skip placeholder
 */
export function adapterFor(model?: string, provider?: string): ModelAdapter {
  if (!model) return DEFAULT_ADAPTER;
  for (const { matches, adapter } of FAMILY_DETECTORS) {
    if (matches(model, provider)) return adapter;
  }
  return DEFAULT_ADAPTER;
}
