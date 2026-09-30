/**
 * #916 SLICE B — the agent view's wrapped-line cache and per-event
 * render helpers (dispatch-deck-live-view-component.ts).
 *
 * Moved out of the component module as a whole unit (the wrapped-line
 * cache + event line renderer) to keep the component under the 500-line
 * hard limit once the #915 input-line work landed; every line below is
 * verbatim from the component, comments included.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeText } from "./dispatch-deck-line.ts";
import type { LiveEvent, LiveViewTheme } from "./dispatch-deck-live.ts";
import { getBuffer } from "./dispatch-deck-live.ts";

// ---------------------------------------------------------------------------
// Wrapped-line cache
// ---------------------------------------------------------------------------

/**
 * The cache's part discriminator: which logical part of an event a cache
 * entry holds. An explicit `part` token distinguishes the toolCall header
 * ("▸ name") from its body (the pretty-printed JSON) — two different texts
 * that could in principle have the same length. `steer` wraps the full
 * operator-echo line (prefix + text) as one unit. The buffer is append-only
 * (stored events are never mutated), so the event's identity plus its part
 * is a stable key.
 */
type WrapPart = "hdr" | "body" | "steer";

/**
 * Per-event wrapped-line cache, keyed by the event object (a WeakMap —
 * entries die with the event), then (width, thinkingExpanded, part).
 * The toolCall args' pretty-printed form is cached separately (prettyArgs
 * and prettyArgsCache) so JSON.parse + stringify run once per event.
 */
const wrappedCache = new WeakMap<LiveEvent, Map<string, string[]>>();

/**
 * Per-event toolCall args pretty-print cache (separate WeakMap — the value
 * is a single string, not a line array, and the args never change: the
 * buffer is append-only, so JSON.parse + stringify run once per event
 * rather than on every render). Entries die with the event.
 */
const prettyArgsCache = new WeakMap<LiveEvent, string | undefined>();

/** The toolCall args' pretty-printed body (raw when they don't parse), or
 * undefined when the event has no args. Cached per event.
 */
function prettyArgs(ev: Extract<LiveEvent, { kind: "toolCall" }>): string | undefined {
  if (prettyArgsCache.has(ev)) return prettyArgsCache.get(ev);
  const raw = ev.args;
  let body: string | undefined;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      body = JSON.stringify(parsed, null, 2) ?? raw;
    } catch {
      body = raw;
    }
  }
  prettyArgsCache.set(ev, body);
  return body;
}

function wrapCached(
  ev: LiveEvent,
  text: string,
  width: number,
  expanded: boolean,
  part: WrapPart,
): string[] {
  const cacheKey = `${width}|${expanded ? 1 : 0}|${part}`;
  const byKey = wrappedCache.get(ev);
  if (byKey) {
    const hit = byKey.get(cacheKey);
    if (hit) return hit;
  }
  // Sanitise FIRST (the stored text is already sanitised at feed time —
  // idempotent), then wrap. wrapTextWithAnsi guarantees each row is ≤
  // width visible columns; on sanitised input no ANSI survives, so every
  // row satisfies the single-line invariant.
  const rows = wrapTextWithAnsi(sanitizeText(text), width);
  if (!byKey) wrappedCache.set(ev, new Map([[cacheKey, rows]]));
  else byKey.set(cacheKey, rows);
  return rows;
}

/**
 * The wrapped lines for one event at `width` (cached). `expanded`
 * toggles thinking blocks to their full text.
 */
export function eventLines(
  ev: LiveEvent,
  width: number,
  expanded: boolean,
  theme: LiveViewTheme,
): string[] {
  switch (ev.kind) {
    case "text":
      return wrapCached(ev, ev.text, width, expanded, "body");
    case "thinking":
      return expanded
        ? wrapCached(ev, ev.text, width, expanded, "body").map((r) => theme.muted(r))
        : [theme.muted(`▸ thinking (${ev.text.length} chars)`)];
    case "toolCall": {
      // Pretty-print the args (cached per event — see prettyArgs).
      const body = prettyArgs(ev);
      const headerText = `▸ ${sanitizeText(ev.name).replace(/\n+/g, " ")}`;
      if (body === undefined) return wrapCached(ev, headerText, width, expanded, "hdr");
      const header = wrapCached(ev, headerText, width, expanded, "hdr")[0] ?? "";
      return [header, ...wrapCached(ev, body, width, expanded, "body")];
    }
    case "toolResult": {
      // Sanitize the tool name (collapse newlines — sanitizeText preserves
      // them, which would desync the renderer).
      const safeName = sanitizeText(ev.name).replace(/\n+/g, " ");
      const marker = ev.isError ? `✗ ${safeName} (error)` : `✓ ${safeName}`;
      const head = ev.isError ? theme.error(marker) : marker;
      if (!ev.text) return [head];
      return [head, ...wrapCached(ev, ev.text, width, expanded, "body")];
    }
    case "operatorSteer": {
      // #915 — the operator's own steer, rendered distinctly (in muted so
      // it reads as the operator's voice, not the child's) as
      // `you → <label>: <text>`. The label is sanitised + newline-collapsed
      // (it flows from untrusted child output); the text wraps like any
      // other body line.
      //
      // Terminal-safety: wrap the WHOLE logical line as one string so
      // every row satisfies visibleWidth ≤ width. Wrapping the body alone
      // and prepending the prefix to the first row would overflow when
      // the prefix (a long label) is itself wider than width. The muted
      // theme is re-applied to the prefix fragment on the first row after
      // wrapping — since the text is sanitised (no ANSI survives), the
      // plain prefix string is a verbatim substring of the first row.
      const label = sanitizeText(ev.label).replace(/\n+/g, " ");
      const full = `you → ${label}: ${ev.text}`;
      const rows = wrapCached(ev, full, width, expanded, "steer");
      // Re-apply the muted theme to the prefix fragment on the first row.
      // The prefix is always non-empty ("you → "), and wrapTextWithAnsi
      // never emits a leading empty row for non-empty input, so the
      // prefix always sits at the start of row 0.
      const plainPrefix = `you → ${label}: `;
      const first = rows[0];
      if (first?.startsWith(plainPrefix)) {
        // #915 lens r1 — build a NEW first row rather than assigning
        // rows[0]: `rows` is the cached array (wrapCached), so the
        // mutation would persist the themed row into the cache and leak
        // it into every later read of the same (event, width, part).
        return [theme.muted(plainPrefix) + first.slice(plainPrefix.length), ...rows.slice(1)];
      }
      return rows;
    }
  }
}

/** The body's total wrapped lines at `width` (the scroll domain). */
export function bodyLineCount(
  key: string,
  width: number,
  expanded: boolean,
  theme: LiveViewTheme,
): number {
  let n = 0;
  for (const ev of getBuffer(key)) n += eventLines(ev, width, expanded, theme).length;
  return n;
}
