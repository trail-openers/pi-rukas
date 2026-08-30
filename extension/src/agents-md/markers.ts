/**
 * markers — the parse / validate / splice primitives for pi-ensemble's
 * AGENTS.md managed sections.
 *
 * ## The invariant this whole file exists to hold
 *
 * A marker pair is the ONLY place the renderer may change bytes:
 *
 *     <!-- pi-ensemble:agents-md:begin <id> v1 -->
 *     …managed content…
 *     <!-- pi-ensemble:agents-md:end <id> -->
 *
 * `splice` reconstructs the file as `text[:contentStart] + body +
 * text[contentEnd:]`. Everything before the first content byte and after the
 * last content byte is copied straight from the input, so hand-written prose
 * and other owners' marker blocks survive **byte-for-byte by construction** —
 * not because a diff was taken and applied, but because they were never read
 * as anything other than literal bytes. This is the regression that clud-bug
 * #253 proved: a regenerator that touches content outside its own marker pairs
 * deletes adjacent hand-written work. There is no code path here that can do
 * that, because splice never assembles "the rest of the file" — it keeps the
 * original prefix and suffix verbatim.
 *
 * ## Corruption is an error, never a guess
 *
 * `parseMarkers` refuses nested pairs, duplicate ids, mismatched
 * begin/end, and orphan (begin without end) markers. A bad splice that is
 * detected BEFORE writing is an error; one that is only detected after the
 * file is on disk is data loss. Every corruption shape is a thrown error.
 */

export const MARKER_VERSION = 1;

/** The managed section ids this renderer knows. */
export const SECTION_IDS = ["quality-gates", "commands", "environment", "decision-ledger"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const BEGIN_RE = /<!--\s*pi-ensemble:agents-md:begin\s+([a-z][a-z0-9-]*)\s+v(\d+)\s*-->/g;
const END_RE = /<!--\s*pi-ensemble:agents-md:end\s+([a-z][a-z0-9-]*)\s*-->/g;
/**
 * The LOOSE form of every marker occurrence — begin or end, any id shape, any
 * version shape. Used as a corruption tripwire: if the loose scan finds more
 * occurrences than BEGIN_RE + END_RE captured together, a token exists that
 * neither strict regex recognised (e.g. a begin line missing `v<N>`, or a
 * drifted version like `v2` when pairing expects otherwise, or an unknown id
 * character). Silently ignoring such a token would let its END be captured as
 * an orphan while its BEGIN is invisible, so a mis-versioned pair must throw,
 * not vanish.
 */
const LOOSE_RE = /<!--\s*pi-ensemble:agents-md:(begin|end)\b[^>]*-->/g;

/**
 * The byte range of a single managed section, plus its markers.
 *
 * `contentStart` is the index just AFTER the begin marker's newline;
 * `contentEnd` is the index just BEFORE the end marker's line. The content in
 * between is what a re-render may replace.
 */
export interface MarkerSpan {
  id: string;
  version: number;
  /** Index of the first character of the begin marker (inclusive). */
  beginMarkerStart: number;
  /** Index one past the last character of the begin marker (exclusive). */
  beginMarkerEnd: number;
  /** Index of the first managed-content character (after the begin newline). */
  contentStart: number;
  /** Index of the last managed-content character (before the end marker). */
  contentEnd: number;
  /** Index of the first character of the end marker (inclusive). */
  endMarkerStart: number;
  /** Index one past the last character of the end marker (exclusive). */
  endMarkerEnd: number;
}

/** A corruption shape, with a human reason. */
export class MarkerError extends Error {}

/** The result of a successful parse: every managed section in document order. */
export interface ParsedMarkers {
  spans: MarkerSpan[];
}

function markerIdLine(id: string, kind: "begin" | "end", version?: number): string {
  return version === undefined
    ? `<!-- pi-ensemble:agents-md:${kind} ${id} -->`
    : `<!-- pi-ensemble:agents-md:${kind} ${id} v${version} -->`;
}

/**
 * Parse every managed marker pair in `text`.
 *
 * Throws MarkerError on: a begin with no matching end (orphan), an end with no
 * matching begin (stray), a begin nested inside another open span (nesting),
 * a repeated id (duplicate), and a begin/end whose ids disagree (mismatch).
 */
export function parseMarkers(text: string): ParsedMarkers {
  interface Token {
    kind: "begin" | "end";
    id: string;
    version: number;
    start: number; // first char of the marker
    end: number; // one past last char of the marker
  }

  const tokens: Token[] = [];
  for (const re of [BEGIN_RE, END_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m.index === re.lastIndex) re.lastIndex++;
      tokens.push({
        kind: re === BEGIN_RE ? "begin" : "end",
        id: m[1] as string,
        version: re === BEGIN_RE ? Number.parseInt(m[2] ?? "1", 10) : 0,
        start: m.index,
        end: re.lastIndex,
      });
    }
  }

  // Tripwire: any marker-shaped token the strict regexes did NOT capture is a
  // corrupt or mis-versioned marker. Count loose occurrences and refuse if the
  // strict capture is short of them — never silently ignore one.
  LOOSE_RE.lastIndex = 0;
  const captured = new Set(tokens.map((t) => t.start));
  for (let m = LOOSE_RE.exec(text); m !== null; m = LOOSE_RE.exec(text)) {
    if (m.index === LOOSE_RE.lastIndex) LOOSE_RE.lastIndex++;
    if (!captured.has(m.index)) {
      throw new MarkerError(
        `corrupt or mis-versioned marker: ${m[0].replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }

  tokens.sort((a, b) => a.start - b.start);

  const spans: MarkerSpan[] = [];
  const openStack: Token[] = []; // open begin markers, innermost last
  const seenIds = new Set<string>();

  for (const tok of tokens) {
    if (tok.kind === "begin") {
      if (openStack.length > 0) {
        const top = openStack[openStack.length - 1];
        throw new MarkerError(
          `nested markers: begin "${tok.id}" inside begin "${top ? top.id : "?"}"`,
        );
      }
      if (seenIds.has(tok.id)) {
        throw new MarkerError(`duplicate section id "${tok.id}"`);
      }
      seenIds.add(tok.id);
      openStack.push(tok);
    } else {
      const open = openStack.pop();
      if (open === undefined) {
        throw new MarkerError(`end marker for "${tok.id}" has no matching begin (orphan)`);
      }
      if (open.id !== tok.id) {
        throw new MarkerError(`mismatched markers: begin "${open.id}" closed by end "${tok.id}"`);
      }
      // The managed content is the bytes between the end of the begin marker's
      // line and the start of the end marker's line. Strip one leading and one
      // The managed content is the bytes between the end of the begin marker's
      // line and the start of the end marker's line. Strip one leading newline
      // (the begin marker's line terminator); do NOT strip the trailing newline
      // — the body's own trailing `\n` is the separator that sits just before the
      // end marker, and keeping it inside the content is what makes a re-splice
      // byte-identical to `renderSection`/`appendSection` (which emit
      // `begin\n body\n end` with no extra newline before `end`).
      let contentStart = open.end;
      if (text[open.end] === "\n") contentStart = open.end + 1;
      const contentEnd = tok.start;
      spans.push({
        id: tok.id,
        version: open.version,
        beginMarkerStart: open.start,
        beginMarkerEnd: open.end,
        contentStart,
        contentEnd,
        endMarkerStart: tok.start,
        endMarkerEnd: tok.end,
      });
    }
  }

  if (openStack.length > 0) {
    const first = openStack[0];
    throw new MarkerError(
      `begin marker for "${first ? first.id : "?"}" has no matching end (orphan)`,
    );
  }
  return { spans };
}

/**
 * Replace the managed content of the section `id` with `body`.
 *
 * Returns `text` unchanged if `id` is not present. Throws MarkerError on any
 * corruption (delegated to parseMarkers). `body` should not carry a trailing
 * newline — the splice supplies the separator before the end marker.
 */
export function splice(text: string, id: string, body: string): string {
  const { spans } = parseMarkers(text);
  const span = spans.find((s) => s.id === id);
  if (!span) return text;
  // `contentStart` is just after the begin marker's newline; `contentEnd` is
  // just before the end marker. The managed content is exactly the body, which
  // must carry its own trailing newline as the separator before the end marker.
  // Symmetric with `renderSection`/`appendSection`, so a re-splice reproduces
  // the bytes byte-for-byte.
  const content = body.endsWith("\n") ? body : `${body}\n`;
  return `${text.slice(0, span.contentStart)}${content}${text.slice(span.contentEnd)}`;
}

/**
 * Insert a new managed section at the end of the document.
 *
 * The new section is appended after the last byte of `text` (adding a leading
 * newline if the document does not already end in one), so it never disturbs
 * existing bytes. Throws MarkerError if `id` already exists — an in-place
 * update must go through splice, not a second insertion.
 */
export function appendSection(text: string, id: string, body: string): string {
  const { spans } = parseMarkers(text);
  if (spans.some((s) => s.id === id)) {
    throw new MarkerError(`section id "${id}" already exists; use splice to update it`);
  }
  const cleanBody = body.endsWith("\n") ? body : `${body}\n`;
  const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const begin = markerIdLine(id, "begin", MARKER_VERSION);
  const end = markerIdLine(id, "end");
  return `${text}${prefix}${begin}\n${cleanBody}${end}\n`;
}

/**
 * Insert a new managed section after a target section.
 *
 * The new section is inserted AFTER the end marker of the section with id
 * `targetId`. The insertion seam is at `target.endMarkerEnd`: everything
 * from that point onward is copied verbatim. This satisfies the invariant
 * that bytes after the insertion seam are untouched.
 *
 * When `targetId` is absent from the document, falls back to `appendSection`
 * (append-at-end). Throws MarkerError if `id` already exists.
 *
 * This is the function the scaffold post-pass uses to insert boilerplate
 * sections after the `environment` section during has-markers updates.
 */
export function insertSectionAfter(
  text: string,
  id: string,
  body: string,
  targetId: string,
): string {
  const { spans } = parseMarkers(text);
  if (spans.some((s) => s.id === id)) {
    throw new MarkerError(`section id "${id}" already exists; use splice to update it`);
  }
  const cleanBody = body.endsWith("\n") ? body : `${body}\n`;
  const begin = markerIdLine(id, "begin", MARKER_VERSION);
  const end = markerIdLine(id, "end");
  const target = spans.find((s) => s.id === targetId);

  if (target) {
    // Insert after the target's end marker.
    const prefix = text.length === 0 || text[target.endMarkerEnd] === "\n" ? "" : "\n";
    return `${
      text.slice(0, target.endMarkerEnd) + prefix + begin
    }\n${cleanBody}${end}\n${text.slice(target.endMarkerEnd)}`;
  }
  // Target absent — append-at-end.
  return appendSection(text, id, body);
}

/** Build the marker pair + body as standalone text (for a fresh file). */
export function renderSection(id: string, body: string): string {
  const cleanBody = body.endsWith("\n") ? body : `${body}\n`;
  return `${markerIdLine(id, "begin", MARKER_VERSION)}\n${cleanBody}${markerIdLine(id, "end")}\n`;
}

/**
 * The list of managed section ids present in `text`, in document order.
 * Throws MarkerError on corruption.
 */
export function presentIds(text: string): string[] {
  return parseMarkers(text).spans.map((s) => s.id);
}

/**
 * The raw managed content of a section (between markers), or undefined if the
 * section is absent. Throws MarkerError on corruption.
 */
export function sectionContent(text: string, id: string): string | undefined {
  const span = parseMarkers(text).spans.find((s) => s.id === id);
  if (!span) return undefined;
  return text.slice(span.contentStart, span.contentEnd);
}
