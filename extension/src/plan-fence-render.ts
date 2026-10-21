/**
 * plan-fence-render — how a bounded `outOfScope` entry is ALLOWED TO BE SAID,
 * in a developer prompt or in a trace line (#1744).
 *
 * Split out of plan-fence-bound.ts by the section 12 file-size cap: that module
 * decides WHAT a fence list is (clip, split, cap, record); this one decides what
 * one of its entries may CONTAIN once it leaves the driver. The dependency runs
 * ONE way — plan-fence-bound imports `neutraliseFenceEntry` from here for its
 * trace line, and this module imports no value from it — so there is no cycle,
 * and a caller that only renders a fence never pulls the bound.
 *
 * Why neutralisation is not optional: an `outOfScope` entry is planner-derived
 * text. It arrives from a tool call the model wrote, and pi-rukas's own history
 * is full of prompt-injection classes where derived text reached a prompt or a
 * log unescaped. A fence entry that can contain a newline can write its own
 * `WARN work-driver:` line; one that ends with the driver's own clip marker can
 * forge the disclosure ` …[clipped]` exists to make true. Neither is a plausible
 * fence, which is exactly why neither is allowed to survive here.
 *
 * Importers: `plan-fence-bound.ts` (the trace line and the prompt fence),
 * `work-driver-plan-steers.ts` (a fence quoted in a steered message), and the
 * two #1744 smoke tests.
 */

import { FENCE_CLIP_MARKER, WORKSTREAM_FENCE_MAX } from "./plan-workstream-schema.ts";

/** What the driver appends to say "this text was cut"; never planner text. */
const FORGED_CLIP_MARKER = FENCE_CLIP_MARKER.trim();

/**
 * Control characters, C0/C1 plus the line separators and the zero-width
 * invisible marks, replaced by a space (#1744 review): a trace line is ONE
 * line, and a planner-written ESC or CR is a log-injection primitive — the same
 * reason a fence entry never reaches a prompt raw.
 *
 * Written as a code-point loop rather than a regex class because biome disallows
 * control characters in a regex literal, and the loop states the code-point rule
 * the fence bound follows everywhere else. A run of them collapses to ONE space,
 * so `a\r\nb` and `a   b` both read as `a b` — a fence entry cannot pad a log
 * line with invisible characters either.
 */
function stripControlChars(text: string): string {
  let out = "";
  let run = false;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    const control =
      (code <= 0x1f && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x2060 ||
      code === 0xfeff;
    if (control) {
      if (!run) out += " ";
      run = true;
    } else {
      out += c;
      run = false;
    }
  }
  return out;
}

/**
 * An `outOfScope` entry as it may appear inside a prompt OR a log line: one
 * line, no backticks (they would close the code span a renderer wraps it in),
 * bounded, and with the driver's OWN clip marker stripped (#1744 review): an
 * entry ending in ` …[clipped]` would otherwise render exactly like a fence the
 * driver truncated, forging the disclosure the record exists to make.
 */
export function neutraliseFenceEntry(entry: string): string {
  const cleaned = stripControlChars(entry)
    .replace(/`/g, "'")
    .split(FORGED_CLIP_MARKER)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  // Code points, as every other fence bound (#1744 review): a UTF-16 slice can
  // end between the halves of a surrogate pair, and a lone half in a prompt is
  // noise the developer reads as part of the fence.
  return Array.from(cleaned).slice(0, WORKSTREAM_FENCE_MAX).join("");
}
