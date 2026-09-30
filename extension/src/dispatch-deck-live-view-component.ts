/**
 * #916 SLICE B — the full-screen agent view component.
 *
 * The overlay component the agent view renders: a full-screen
 * (`100%` × `100%`, top-left anchored — see openLiveView's overlay
 * options) list of the job's UNTRUNCATED buffer events, wrapped to the
 * render width.
 *
 * Rendering: every event renders as one or MORE terminal lines (the
 * pre-#916 view pinned one width-bounded line per event):
 *
 *   - assistant text in full, wrapped;
 *   - tool calls as `▸ <tool>` + the args pretty-printed (full JSON
 *     reparsed and re-stringified with 2-space indent when the stored
 *     args parse as JSON, else the raw stored string), in full;
 *   - tool results in full, wrapped;
 *   - thinking collapsed as `▸ thinking (N chars)` by default; the `t`
 *     key toggles ALL thinking blocks to their full text (a shared
 *     view-wide flag — the toggle is view-wide, not per block).
 *
 * Every text goes through the existing sanitiser (dispatch-deck-line.ts
 * `sanitizeText`) BEFORE wrapping, and every output line satisfies
 * visibleWidth ≤ width (wrapTextWithAnsi's contract on sanitised text —
 * no raw control sequences ever reach the terminal).
 *
 * Scrolling is in RENDERED LINES, not events: `↑`/`↓` one line,
 * `PgUp`/`PgDn` one page, `Home`/`g` top, `End`/`G` bottom. Follow mode
 * (auto-stick to the bottom as new events arrive) turns off when
 * scrolling up and back on with `End`. Per-job scroll/follow state
 * persists for the session in a module-level Map keyed by the job key,
 * so it survives the steer re-open loop and a reopen; dropBuffer clears
 * the entry (dispatch-deck-live.ts `clearViewScroll`) so nothing outlives
 * the buffer.
 *
 * Performance: the wrapped lines are cached per event by (event
 * identity, width, thinkingExpanded, part) in a WeakMap keyed by the
 * event object — a render never re-wraps the whole buffer each frame.
 *
 * The view re-reads the buffer on every render: openLiveView subscribes
 * with `onBufferAppend(key, () => tui.requestRender())` so an append
 * re-renders immediately, and the deck's 1 s ticker also re-renders
 * (idempotent — the same buffer, re-read).
 */

import {
  type Component,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { decodeInsertable } from "./deck-key-decode.ts";
import { sanitizeText } from "./dispatch-deck-line.ts";
import type { LiveEvent, LiveViewTheme } from "./dispatch-deck-live.ts";
import { getBuffer } from "./dispatch-deck-live.ts";

export type { LiveViewTheme };

/** The view's status + stats header data. */
export interface ViewHeader {
  label: string;
  role: string;
  /** running / finished / failed / killed (getStatus). */
  status: string;
  startedAt: number;
  now: number;
  turns: number;
  totalTokens: number;
  /** True while the parent agent is streaming ("PM active" badge). */
  pmActive: boolean;
  /** Async-report deliveries while the view is open (badge when > 0). */
  notices: number;
  /** True once the job has settled (final line appended). */
  settled: boolean;
}

/** The TUI the view renders into (duck-typed: terminal dimensions). */
export type TuiHandle = { terminal?: { rows?: number } } | undefined;

/** Fallback body height when the terminal rows are unavailable. */
export const VIEW_FALLBACK_ROWS = 24;

/**
 * The key-legend footer line. #915 — the view's input line is ALWAYS
 * focused: every printable key inserts into it, and the view commands are
 * the non-printing keys only (↑/↓/PgUp/PgDn/Home/End scroll, ctrl+t
 * toggles thinking, Enter sends, Esc clears-then-returns). The `s`/`t`/
 * `g`/`G` letters are gone from the legend — they now type.
 */
export const VIEW_FOOTER_HINT =
  "Message @<label>… · Enter send · ↑↓ scroll · End follow · ^T thinking · Esc back";

/**
 * Per-job scroll/follow state, keyed by the job key. Persists for the
 * session (the module-level Map outlives the component) so the steer
 * re-open loop and a reopen restore the operator's position; cleared by
 * `clearViewScroll` (called from dropBuffer).
 */
interface ViewScrollState {
  /** 0 = following the tail; >0 = lines scrolled back from the bottom. */
  scroll: number;
}

const scrollStates = new Map<string, ViewScrollState>();

export function getViewScrollState(key: string): ViewScrollState {
  let s = scrollStates.get(key);
  if (!s) {
    s = { scroll: 0 };
    scrollStates.set(key, s);
  }
  return s;
}

/**
 * Drop the job's scroll state (dropBuffer calls this — no outlived state).
 * The `getViewScrollState` create-on-read path can leave an entry with no
 * buffer; `dropOrphanedViewScroll` sweeps those so nothing outlives its
 * buffer (called from `openLiveView`'s finally on every close path).
 */
export function clearViewScroll(key: string): void {
  scrollStates.delete(key);
}

/**
 * Remove every scroll-state entry with no live buffer (the create-on-read
 * residue that `clearViewScroll` cannot reach by key, since it runs when no
 * view is open). Called opportunistically when a view closes; safe to call
 * with any buffer set.
 */
export function dropOrphanedViewScroll(hasBuffer: (key: string) => boolean): void {
  for (const key of [...scrollStates.keys()]) {
    if (!hasBuffer(key)) scrollStates.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Wrapped-line cache
// ---------------------------------------------------------------------------

/**
 * The cache's part discriminator: which logical part of an event a cache
 * entry holds. An explicit `part` token distinguishes the toolCall header
 * ("▸ name") from its body (the pretty-printed JSON) — two different texts
 * that could in principle have the same length. The buffer is append-only
 * (stored events are never mutated), so the event's identity plus its part
 * is a stable key.
 */
type WrapPart = "hdr" | "body";

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
function eventLines(
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
      const label = sanitizeText(ev.label).replace(/\n+/g, " ");
      const prefix = theme.muted(`you → ${label}: `);
      // The prefix is already on its own row (a single short line); the
      // wrapped text rows follow. The first row carries the prefix so the
      // echo reads `you → label: text` on one logical line, wrapping the
      // rest onto continuation rows.
      const wrapped = wrapCached(ev, ev.text, width, expanded, "body");
      const rows: string[] = [...wrapped];
      if (rows.length === 0) {
        rows.push("");
      }
      rows[0] = `${prefix}${rows[0] ?? ""}`;
      return rows;
    }
  }
}

/** The body's total wrapped lines at `width` (the scroll domain). */
function bodyLineCount(
  key: string,
  width: number,
  expanded: boolean,
  theme: LiveViewTheme,
): number {
  let n = 0;
  for (const ev of getBuffer(key)) n += eventLines(ev, width, expanded, theme).length;
  return n;
}

/** The body height: the terminal rows minus the header + input + footer lines.
 *  #915 — the input line takes one row, so the body is 3 rows shorter than
 *  the pre-#915 calculation (which only subtracted header + footer). */
function bodyHeight(tui: TuiHandle): number {
  const rows = tui?.terminal?.rows;
  const h = typeof rows === "number" && rows > 3 ? rows : VIEW_FALLBACK_ROWS;
  return Math.max(1, h - 3);
}

function fmtElapsed(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 1000));
  if (m < 60) return `${m}s`;
  return `${Math.floor(m / 60)}m${m % 60}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Build the full-screen agent view component. The factory returns the
 * returned object DIRECTLY from `ctx.ui.custom` (never Container-wrapped
 * — #176: keys route to the focused component).
 */
export function createAgentViewComponent(
  key: string,
  header: () => ViewHeader,
  theme: LiveViewTheme,
  tui: TuiHandle,
  done: (result: "close" | "returnToList") => void,
  onSend: (text: string) => void,
): Component & {
  inputValue: () => string;
  clearInput: () => void;
  setStatus: (s: { text: string; ok: boolean } | undefined) => void;
} {
  // View-local: the thinking toggle is per view instance (a fresh open
  // starts collapsed); scroll/follow is per job key (persists).
  let thinkingExpanded = false;
  const state = getViewScrollState(key);
  // The render width is needed by handleInput's scroll clamp — captured
  // on each render (the width is stable for the view's lifetime).
  let lastWidth = 80;
  // The body's rendered line count, written by render() and read by
  // handleInput's scroll clamp (render always runs before input is routed,
  // so the sentinel -1 is never read — but guard anyway for a first
  // handleInput on a fresh view).
  let lastBodyLen = -1;
  // #915 — the always-focused message input: a plain string buffer
  // (component state — the input line is the focused surface, every
  // printable key inserts into it). Paste arrives as a multi-char chunk;
  // newlines collapse to spaces. The buffer is stored raw; rendering
  // sanitises + width-bounds it (showing the TAIL of a long input) and the
  // send path sanitises again (idempotent) before delivery.
  let input = "";
  // #915 — the inline send status (✓ sent / ⧗ between rounds / ✗ reason),
  // set by the view host after a send. REPLACED by the next send's result
  // and CLEARED when the job settles (the settled final line takes over).
  // (Named sendStatus — the render body uses a local `status` for the job's
  // settle status.)
  let sendStatus: { text: string; ok: boolean } | undefined;
  const comp: {
    invalidate: () => void;
    render: (width: number) => string[];
    handleInput: (data: string) => void;
    inputValue: () => string;
    clearInput: () => void;
    setStatus: (s: { text: string; ok: boolean } | undefined) => void;
  } = {
    invalidate(): void {
      /* wrapped lines are cached per event — nothing to drop here */
    },
    render(width: number): string[] {
      lastWidth = width;
      const h = header();
      const status = h ? h.status : "running";
      const settled = h ? h.settled : false;
      const height = bodyHeight(tui);
      // Build the full body once (the window is a slice of it). The wrap
      // cache keeps this O(buffer) map lookups per render, not a re-wrap.
      const body: string[] = [];
      for (const ev of getBuffer(key)) body.push(...eventLines(ev, width, thinkingExpanded, theme));
      if (settled) body.push(`— ${status} · press Esc —`);
      lastBodyLen = body.length;
      // The scroll domain is the body's wrapped lines (+1 final line on
      // settle). Clamp the persisted scroll into [0, maxScroll].
      const total = lastBodyLen + (settled ? 1 : 0);
      const maxScroll = Math.max(0, total - height);
      state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
      const start = Math.max(0, body.length - height - state.scroll);
      const window: string[] = [];
      for (let i = start; i < Math.min(body.length, start + height); i++) {
        const line = body[i];
        if (line !== undefined) window.push(line);
      }
      const headerRaw = h
        ? `${sanitizeText(h.label).replace(/\n+/g, " ")} · ${sanitizeText(h.role).replace(/\n+/g, " ")} · ${status} · ${fmtElapsed(h.now - h.startedAt)} · ${h.turns} turn${h.turns === 1 ? "" : "s"} · ${h.totalTokens} tokens${h.pmActive ? " · PM active" : ""}${h.notices > 0 ? ` · ${h.notices} new notices` : ""}`
        : status;
      // sanitizeText AFTER truncateToWidth: truncateToWidth adds ANSI reset
      // sequences (\x1b[0m) around the ellipsis, which sanitizeText strips.
      // The input is already sanitised (headerRaw uses sanitizeText on each
      // field), so the post-truncate sanitize only removes the reset codes.
      const headerLine = sanitizeText(truncateToWidth(headerRaw, width, "…"));
      const lines: string[] = [headerLine, ...window];
      // Pad the body to the full height so the input/status/footer sit on
      // the last three rows of the full-screen overlay.
      while (lines.length < height + 3) lines.push("");
      // #915 — the input line (always focused): `Message @<label>: <text>`
      // with a visible cursor (the trailing `▍`) at the end. The text is
      // sanitised + width-bounded, showing the TAIL of a long input (the
      // operator's own text — the leading prompt is short and the tail is
      // what matters when the buffer grows). The inline send status, when
      // present, replaces the label part of the line; cleared on settle.
      const label = h ? sanitizeText(h.label).replace(/\n+/g, " ") : key;
      const cursor = "\u258D";
      if (settled && sendStatus) {
        // The settled final line takes over — the inline status is cleared.
        sendStatus = undefined;
      }
      let inputLine: string;
      if (sendStatus) {
        // The result glyph (✓ / ⧗ / ✗) leads the inline status; muted so it
        // reads as a status line, not an input line.
        inputLine = theme.muted(`${sendStatus.text} · Esc back`);
      } else {
        // Show the tail of the input: truncateToWidth from the left is not
        // available, so take the last (width - prompt - cursor) chars and
        // let the ellipsis mark the truncated head. The prompt + cursor are
        // short; the text budget is the remainder.
        const prompt = `Message @${label}: `;
        const budget = Math.max(1, width - prompt.length - 1);
        const shown =
          input.length <= budget
            ? input
            : `…${sanitizeText(input).slice(input.length - budget + 1)}`;
        inputLine = `${prompt}${sanitizeText(shown)}${cursor}`;
      }
      lines.push(inputLine);
      const footer =
        state.scroll === 0
          ? VIEW_FOOTER_HINT.slice(0, Math.max(1, width - 1))
          : `paused (End to follow) · ${VIEW_FOOTER_HINT}`.slice(0, Math.max(1, width - 1));
      lines.push(theme.muted(footer));
      return lines;
    },
    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      const height = bodyHeight(tui);
      const h = header();
      const settled = h ? h.settled : false;
      // The scroll domain is the body's wrapped lines. Use lastBodyLen when
      // render has run at least once (the common case); otherwise fall back
      // to a direct count so a first handleInput before render still clamps.
      const total =
        (lastBodyLen >= 0 ? lastBodyLen : bodyLineCount(key, lastWidth, thinkingExpanded, theme)) +
        (settled ? 1 : 0);
      const maxScroll = Math.max(0, total - height);
      // #915 — the input line is ALWAYS focused. Non-printing keys drive the
      // view; every PRINTABLE key (including letters t/x/g/s, digits, space,
      // symbols) inserts into the input. Ctrl+t toggles thinking (replacing
      // the old `t`); Home/End cover the old `g`/`G`.
      if (matchesKey(data, "escape")) {
        // Esc: clear the input if non-empty (no done); if empty, return.
        if (input.length > 0) {
          input = "";
        } else {
          done("returnToList");
        }
      } else if (matchesKey(data, "ctrl+t")) {
        // ctrl+t toggles thinking (the non-printing replacement for `t`).
        thinkingExpanded = !thinkingExpanded;
      } else if (matchesKey(data, "enter")) {
        // Enter: send if the input is non-empty; a no-op when empty.
        // The buffer is cleared BEFORE the (async) send callback, so a
        // double-Enter finds an empty buffer and is a no-op — the same
        // text can never fire two concurrent sends.
        if (input.length > 0) {
          const text = input;
          input = "";
          onSend(text);
        }
      } else if (matchesKey(data, "backspace")) {
        if (input.length > 0) input = input.slice(0, -1);
      } else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
        state.scroll = Math.min(maxScroll, state.scroll + (matchesKey(data, "up") ? 1 : height));
      } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
        state.scroll = Math.max(0, state.scroll - (matchesKey(data, "down") ? 1 : height));
      } else if (matchesKey(data, "home")) {
        state.scroll = maxScroll;
      } else if (matchesKey(data, "end")) {
        state.scroll = 0; // follow on
      } else {
        // #915 — everything else is INSERT or SWALLOW, decided by
        // decodeInsertable (deck-key-decode.ts):
        //   - a single printable char (ASCII 32–126) inserts as-is —
        //     letters (including t/x/g/s which the old view treated as
        //     commands), digits, symbols, space;
        //   - a Kitty CSI-u / modifyOtherKeys sequence that decodes to a
        //     printable char (non-ASCII é/CJK/emoji, shifted letters) is
        //     decoded and the CHARACTER is inserted — raw sequences never
        //     reach the buffer;
        //   - multi-char text (a bracketed paste, an IME composition
        //     commit) inserts with newlines collapsed to spaces;
        //   - everything else (unknown escape sequences — F-keys, mouse
        //     SGR, alt+x, arrow-key sequences, lone ESC, control bytes)
        //     is swallowed: garbage in the message buffer would desync the
        //     terminal line accounting (issue #927's class).
        // A key-release was already filtered at the top of handleInput.
        const insert = decodeInsertable(data);
        if (insert !== undefined) input += insert;
      }
    },
    // #915 — the input accessors the host (openLiveView) uses in the send
    // callback: read the buffer, clear it after a successful send, and set
    // the inline status.
    inputValue: () => input,
    clearInput: () => {
      input = "";
    },
    setStatus: (s: { text: string; ok: boolean } | undefined) => {
      sendStatus = s;
    },
  };
  return comp;
}
