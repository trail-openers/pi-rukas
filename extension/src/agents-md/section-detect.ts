/**
 * section-detect — the ONE shared heading-based detector for pi-rukas's
 * AGENTS.md managed sections (ticket M2, companion to M1/#680).
 *
 * This module replaces the marker-comment mechanism (markers.ts, being
 * deleted). A pi-rukas-managed section is identified purely by the TEXT of
 * its heading line (e.g. `## Code Style`, `# Git Workflow`), never by an
 * embedded `<!-- ... -->` marker. The rendered file is pure prose: headings
 * and body text only.
 *
 * ## The two merged half-built detectors
 *
 * Two partial heading detectors existed before this module:
 *   - wrap.ts `headingToId` + `contentMatchesId` — the four FACT-section ids
 *     (quality-gates, commands, environment, code-style), `##`-level,
 *     exact-word-set matching, with per-id content shape predicates.
 *   - update-agent.ts / scaffold.ts `SCAFFOLD_HEADING_MAP` — the seven
 *     BOILERPLATE ids (git-workflow, ...), matched case-insensitively with
 *     parenthetical tolerance at any heading level.
 *
 * `managedIdForHeading` + `MANAGED_HEADING_TEXT` are the single source that
 * merges both: one heading-name→id table covering all 12 managed ids (4 fact
 * + 7 scaffold + operator-choices), the exact heading text the renderer
 * emits per id, and the delimiter rule that makes a detection boundary
 * correct in a file with mixed heading levels.
 *
 * ## The delimiter rule (load-bearing)
 *
 * A managed section spans from its heading line to the next heading whose
 * LEVEL is ≤ its own level — never at a deeper heading inside it. So the
 * scaffold's `# Git Workflow` (h1) contains the h2s `## Conventional
 * commits` / `## Branch protection` and does NOT end at them; it ends at the
 * next h1 (or EOF). A fact section emitted as `## Commands` ends at the next
 * `##` or `#`, never at an internal `###`. This is why the old wrap.ts
 * `findSections` (which split on `/^##\s+/` only) was h1-blind and could not
 * be reused: it would swallow an entire h1 scaffold section as one section.
 *
 * ## One-pass migration strip
 *
 * `stripLegacyMarkers` is the migration transform for files that still carry
 * the old HTML-comment markers (the three golden fixtures, plus the five real
 * repos touched this session). It removes EXACTLY the recognised
 * `<!-- pi-rukas:agents-md:begin/end ... -->` and
 * `<!-- pi-ensemble:agents-md:begin/end ... -->` pair lines and the
 * `:managed` preamble comment line, and preserves every other byte verbatim.
 * It does NOT synthesise `##` headings around the now-markerless body spans
 * — the heading re-anchoring is the renderer's job on a later run, not the
 * strip's. A second application is a byte-identical no-op (idempotent by
 * construction: only comment lines are deleted).
 *
 * ## The corruption invariant (renamed error type)
 *
 * The error shape is `SectionError` (the marker-era name `MarkerError` lived
 * in the now-deleted markers.ts). "Corruption is an error, never a guess" is
 * carried over: a duplicate managed heading, or a section whose body cannot
 * be located, is refused, not guessed.
 */

/** The error type for a heading-structure corruption (refuse, never guess). */
export class SectionError extends Error {}

/**
 * The single managed-id → exact-heading-text table (all 12 managed ids).
 *
 * The four FACT ids use the `##` fact-section level; the seven scaffold ids
 * use the `#` h1 level (matching SCAFFOLD_BODIES, whose bodies emit `# <name>`
 * as their first line); operator-choices is the scaffold's h2 section. The
 * text here is the DETECTION KEY and must equal what the renderer emits, so
 * `renderHeadingFor` + `managedIdForHeading` round-trip.
 */
export const MANAGED_HEADING_TEXT: Record<string, string> = {
  // fact sections (## level)
  "quality-gates": "## Quality Gates",
  commands: "## Commands",
  environment: "## Environment",
  "code-style": "## Code Style",
  // scaffold boilerplate (# level — first line of each SCAFFOLD_BODIES body)
  "minimalist-engineering": "# Minimalist Engineering",
  "git-workflow": "# Git Workflow",
  "documentation-policy": "# Documentation Policy",
  "issue-driven-development": "# Issue-Driven Development",
  "code-review-doctrine": "# Code Review Doctrine",
  "context7-protocol": "# Context7 Protocol",
  "testing-standards": "# Testing Standards",
  // scaffold operator-choices (## level, per renderOperatorChoices)
  "operator-choices": "## Operator choices",
};

/** All managed section ids (the 4 fact + 7 scaffold + operator-choices). */
export const MANAGED_IDS: string[] = Object.keys(MANAGED_HEADING_TEXT);

/** The heading level (1-based # count) a managed id renders at. */
export function headingLevelFor(id: string): number {
  const text = MANAGED_HEADING_TEXT[id];
  if (!text) return 2;
  return (text.match(/^#+/) ?? ["##"])[0].length;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** The parsed form of a heading line, or undefined when the line is not a heading. */
interface ParsedHeading {
  line: number;
  level: number;
  /** The heading text with `#` markers and leading/trailing whitespace trimmed. */
  text: string;
  raw: string;
}

/**
 * The line range of a heading-delimited managed section.
 *
 * `headingLine` is the 0-based index of the heading line. `contentStart` is
 * the index of the first content line (after the heading). `contentEnd` is
 * one past the last content line (exclusive) — the section runs to the next
 * heading of level ≤ its own, or to the last line if none. `body` is the
 * content lines joined with `\n` (trailing blank lines trimmed), so an
 * empty-bodied section yields `""`.
 */
export interface SectionSpan {
  id: string;
  /** The exact heading line (e.g. `## Commands`). */
  heading: string;
  level: number;
  headingLine: number;
  /** 0-based index of the first content line. */
  contentStart: number;
  /** 0-based index one past the last content line (exclusive). */
  contentEnd: number;
  /** The content lines (heading excluded) joined with `\n`, trailing blanks trimmed. */
  body: string;
}

/**
 * Map a heading's text to a managed id, or undefined.
 *
 * Exact word-set matching only (the wrap.ts doctrine): `## Quality` alone is
 * NOT quality-gates, and `## Quality Gates (blocking)` is NOT the 2-word
 * `quality-gates` pair — the word count disambiguates. Case and
 * word-separator tolerant (quality_gates / Quality-Gates name the same id).
 * A heading that only *resembles* a managed id ("My Commands") stays doctrine.
 */
export function managedIdForHeading(heading: string): string | undefined {
  const m = HEADING_RE.exec(heading.trim());
  if (!m) return undefined;
  const words = (m[2] ?? "").toLowerCase().replace(/[_.]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words[0] === "quality" && words[1] === "gates" && words.length === 2) return "quality-gates";
  if (words.length === 1 && (words[0] === "commands" || words[0] === "command")) return "commands";
  if (words.length === 1 && (words[0] === "environment" || words[0] === "environments"))
    return "environment";
  if (words[0] === "code" && words[1] === "style" && words.length === 2) return "code-style";
  // The scaffold + operator-choices ids match on their exact word set, word
  // for word, against the rendered heading text. The length check excludes
  // the parenthetical "Quality Gates (blocking)" false-positive class by
  // construction (different word count than the 2-word "quality gates").
  for (const [id, text] of Object.entries(MANAGED_HEADING_TEXT)) {
    if (id === "quality-gates" || id === "commands" || id === "environment" || id === "code-style")
      continue; // already handled above
    const t = HEADING_RE.exec(text.trim());
    if (!t) continue;
    const target = (t[2] ?? "").toLowerCase().replace(/[_.]+/g, " ").split(/\s+/).filter(Boolean);
    if (target.length === words.length && target.every((w, i) => w === words[i])) {
      return id;
    }
  }
  return undefined;
}

/** The exact heading line the renderer emits for a managed id. */
export function renderHeadingFor(id: string): string {
  const text = MANAGED_HEADING_TEXT[id];
  if (!text) throw new SectionError(`unknown managed id "${id}" — no heading text defined`);
  return text;
}

/**
 * Find every managed section in `text` as a heading-delimited span.
 *
 * A section is delimited from its heading line to the next heading whose
 * level is ≤ its own level, or to EOF (the last line) if no such heading
 * follows. A duplicate managed heading (the same id appearing twice) is a
 * structural corruption and throws `SectionError` — never a silent pass.
 */
export function findManagedSections(text: string): SectionSpan[] {
  const lines = text.split("\n");
  // Collect every heading line with its level and managed id (if any).
  const headings: ParsedHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = HEADING_RE.exec(line.trim());
    if (!m) continue;
    const level = (m[1] ?? "").length;
    headings.push({ line: i, level, text: (m[2] ?? "").trim(), raw: line });
  }

  const spans: SectionSpan[] = [];
  const seen = new Set<string>();

  for (let h = 0; h < headings.length; h++) {
    const head = headings[h];
    if (!head) continue;
    const id = managedIdForHeading(head.raw);
    if (!id) continue;
    if (seen.has(id)) {
      throw new SectionError(
        `duplicate managed heading "${head.raw}" (id "${id}"); it appears twice — refusing to guess which span is managed`,
      );
    }
    seen.add(id);

    // The section ends at the next heading with level <= this heading's
    // level, or at the last line of the file (a trailing managed section
    // runs to EOF, including its trailing newline).
    let endLine = lines.length - 1; // last line index
    for (let k = h + 1; k < headings.length; k++) {
      const nxt = headings[k];
      if (!nxt) continue;
      if (nxt.level <= head.level) {
        endLine = nxt.line - 1;
        break;
      }
    }

    // Body convention (shared with spliceManagedSection so read+re-splice
    // round-trips are byte-identical): the body is the raw run of lines from
    // the line AFTER the heading (so it LEADS with the blank separator line
    // the renderer emits) through the last non-blank content line. An empty
    // section (heading immediately followed by a boundary) yields "". The
    // trailing blank before the next heading is NOT part of the body; the
    // next heading line starts the following section.
    let lastNonBlank = -1;
    for (let k = endLine; k > head.line; k--) {
      if ((lines[k] ?? "").trim() !== "") {
        lastNonBlank = k;
        break;
      }
    }
    const contentEnd = lastNonBlank >= 0 ? lastNonBlank + 1 : head.line + 1;
    const body =
      contentEnd > head.line + 1 ? lines.slice(head.line + 1, contentEnd).join("\n") : "";

    spans.push({
      id,
      heading: head.raw,
      level: head.level,
      headingLine: head.line,
      contentStart: head.line + 1,
      contentEnd,
      body,
    });
  }
  return spans;
}

/**
 * The ids of every managed section present in `text`, in document order.
 * Throws SectionError on a duplicate managed heading.
 */
export function presentManagedIds(text: string): string[] {
  return findManagedSections(text).map((s) => s.id);
}

/**
 * The heading-delimited body of the managed section `id`, or undefined when
 * absent. Returned in the caller-facing convention: blank separator after
 * the heading + content + trailing newline (an empty section is ""). A
 * managed id that was never given a heading (e.g. the decision-ledger, which
 * is now a sidecar) simply returns undefined — absence is not corruption.
 * Throws SectionError on a duplicate managed heading.
 */
export function managedSectionBody(text: string, id: string): string | undefined {
  const span = findManagedSections(text).find((s) => s.id === id);
  if (!span) return undefined;
  return span.body === "" ? "" : `${span.body}\n`;
}

/**
 * Replace the body of managed section `id` with `body`, preserving the
 * heading line and every byte outside the section. Returns `text` unchanged
 * when `id` is absent. A `body` without a trailing newline is normalised to
 * carry one (the delimiter before the next section is a blank line the
 * renderer emits). Throws SectionError on a duplicate managed heading.
 *
 * The replacement is structural: bytes before the section and after the
 * section are copied verbatim, so hand-written prose and other owners'
 * comments survive byte-for-byte by construction (the #253 invariant).
 */
/**
 * Normalise a caller body to the stored convention (blank separator after
 * the heading + content, no trailing newline). A body that ALREADY carries
 * a leading blank separator is taken to be in stored form (the no-op
 * re-splice case) and only its trailing newline (if any) is dropped; a body
 * without a leading separator gets the blank separator prepended (the
 * update case). An empty body stays empty.
 */
function spliceForm(body: string): string {
  if (body === "") return "";
  if (body.startsWith("\n")) {
    // Already in stored form (leading separator present): drop only a
    // trailing newline if there is one.
    return body.endsWith("\n") ? body.slice(0, -1) : body;
  }
  return `\n${body}`.replace(/\n$/, "");
}

export function spliceManagedSection(text: string, id: string, body: string): string {
  const spans = findManagedSections(text);
  const span = spans.find((s) => s.id === id);
  if (!span) return text;
  // Body-convention splice (matches `findManagedSections`): the span between
  // the heading line and the next ≤-level heading (or EOF) is replaced with
  // exactly the stored body — which, by convention, LEADS with the blank
  // separator line after the heading (or is "" for an empty section) and
  // carries no trailing newline (the following blank line / next heading is
  // the `rest`). Replacing the same span with the same body reproduces the
  // file byte-for-byte: the idempotency the ticket requires.
  const lines = text.split("\n");
  const headLine = span.headingLine;
  // The span is lines headLine+1 .. span.contentEnd-1 (contentEnd is one past
  // the last non-blank content line); everything from contentEnd onward (the
  // trailing blank(s) and the next heading) is copied verbatim as `rest`.
  // The stored body (by convention: blank separator + content, no trailing
  // newline) replaces the span exactly, so re-splicing the same body is a
  // byte-identical no-op (the idempotency the ticket requires).
  const newBodyLines = spliceForm(body) === "" ? [] : spliceForm(body).split("\n");
  const before = lines.slice(0, headLine + 1); // through the heading line
  const rest = lines.slice(span.contentEnd); // separator + next section onward
  return [...before, ...newBodyLines, ...rest].join("\n");
}

/**
 * Append a new managed section (heading + body) at the end of `text`.
 * Returns `text` unchanged is NOT possible — appending is the caller's
 * explicit choice. Throws SectionError if `id` is already present (an
 * in-place update must go through spliceManagedSection).
 */
export function appendManagedSection(text: string, id: string, body: string): string {
  const known = MANAGED_HEADING_TEXT[id];
  if (!known) throw new SectionError(`unknown managed id "${id}" — no heading text defined`);
  const clean = body.endsWith("\n") ? body : `${body}\n`;
  // SCAFFOLD_BODIES embed the heading line in the body (e.g. the body starts
  // with `# Git Workflow`). If the body starts with ANY heading line, the body
  // IS the full section and is appended verbatim (no second heading); only a
  // heading-less body gets the canonical heading from the single-source table.
  const headingLine = /^(#{1,6})\s/.test(clean) ? undefined : known;
  const block = headingLine ? `${headingLine}\n\n${clean}` : clean;
  const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return text.length === 0 ? `${block}\n` : `${text}${prefix}\n${block}\n`;
}

/**
 * The insertion seam for `targetId`: the byte offset one past the section's
 * last body character, with the separator newline(s) after it skipped (the
 * inserted section is separated from the target by exactly one blank line).
 * Returns undefined when the target section is absent.
 */
function managedSectionEndOffset(text: string, targetId: string): number | undefined {
  const s = findManagedSections(text).find((x) => x.id === targetId);
  if (!s) return undefined;
  // contentEnd is one past the last content line; the offset just after that
  // line's text is where the separator blank(s) begin.
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < s.contentEnd; i++) off += (lines[i] ?? "").length + 1;
  let end = off;
  if (end < text.length && (text[end] ?? "") === "\n") end++;
  while (end < text.length && (text[end] ?? "") === "\n") end++;
  return end;
}

/**
 * Insert a new managed section AFTER the managed section `targetId` (after
 * its delimiter boundary, before the following content). Falls back to
 * appendManagedSection when the target is absent. Throws SectionError if
 * `id` already exists.
 *
 * This is the heading-equivalent of the marker-era `insertSectionAfter` the
 * scaffold post-pass uses (insert boilerplate after `environment`). The
 * insertion seam is at the target section's delimiter boundary (the last line
 * of the target's section, i.e. the blank line before the next ≤-level
 * heading or EOF); bytes after the seam are copied verbatim.
 */
export function insertManagedSectionAfter(
  text: string,
  id: string,
  body: string,
  targetId: string,
): string {
  const spans = findManagedSections(text);
  if (spans.some((s) => s.id === id)) {
    throw new SectionError(`section id "${id}" already exists; use splice to update it`);
  }
  const seam = managedSectionEndOffset(text, targetId);
  if (seam === undefined) return appendManagedSection(text, id, body);
  const known = MANAGED_HEADING_TEXT[id];
  if (!known) throw new SectionError(`unknown managed id "${id}" — no heading text defined`);
  const clean = body.endsWith("\n") ? body : `${body}\n`;
  // A body carrying its own heading line (scaffold bodies do) is inserted
  // verbatim; a heading-less body gets the canonical heading.
  const headingLine = /^(#{1,6})\s/.test(clean) ? undefined : known;
  const block = headingLine ? `${headingLine}\n\n${clean}` : clean;
  const tail = text.slice(seam);
  if (/^#{1,6}\s/.test(tail)) {
    // The tail starts at the next section's heading: head + one blank line +
    // the block + one blank line + tail.
    return `${text.slice(0, seam)}\n${block}\n${tail}`;
  }
  // Plain-prose tail: collapse the target's trailing blank(s) to one blank
  // line, insert the block, then the prose without its leading blanks.
  const head = text.slice(0, seam).replace(/\n+$/, "");
  const prose = tail.replace(/^\n+/, "");
  return `${head}\n\n${block}${prose}`;
}

// ---------------------------------------------------------------- migration

/**
 * A line that the one-pass migration strip must delete: any recognised
 * pi-rukas / pi-ensemble managed marker (begin or end, any version shape) or
 * the `:managed` preamble comment. Foreign owners' comments and unrelated
 * HTML comments are NOT matched and survive byte-for-byte.
 */
const LEGACY_MARKER_LINE_RE =
  /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:(?:begin\s+[a-z][a-z0-9-]*(?:\s+v\d+)?|end\s+[a-z][a-z0-9-]*|managed[^\n]*?)\s*-->/;

/**
 * Remove the in-file decision-ledger body (the markdown table that was
 * marker-wrapped by the pre-M1 format) from `text`. Post-#681 M2 the ledger
 * lives in the sidecar; this is a one-shot migration helper for files that
 * still carry the table inline (with no heading — the sidecar migration is
 * M1's concern, not M2's).
 *
 * The table is identified by its `| key | value | provenance |` header line
 * and extends through all consecutive `|` lines. Surrounding blank lines are
 * stripped; the result is byte-identical on a second pass (no table left to
 * remove).
 */
export function removeInFileLedgerBody(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*key\s*\|\s*value\s*\|\s*provenance\s*\|\s*$/.test(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) return text;
  let end = start;
  while (end < lines.length && /^\|/.test(lines[end] ?? "")) end++;
  let s = start;
  if (s > 0 && (lines[s - 1] ?? "").trim() === "") s--;
  let e = end;
  if (e < lines.length && (lines[e] ?? "").trim() === "") e++;
  const out = [...lines.slice(0, s), ...lines.slice(e)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The one-pass migration strip: remove EXACTLY the recognised managed
 * marker lines (begin/end, both pi-rukas and pi-ensemble prefixes, any
 * version shape) and the `:managed` preamble comment line, preserving every
 * other byte verbatim (including foreign owners' `<!-- ... -->` comments).
 *
 * Does NOT add headings around the now-markerless spans (that is the
 * renderer's later job). Idempotent: a second application deletes nothing
 * (only comment lines are removed, and they are gone after the first pass).
 */
export function stripLegacyMarkers(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("<!--") &&
      trimmed.endsWith("-->") &&
      LEGACY_MARKER_LINE_RE.test(trimmed)
    ) {
      continue; // recognised managed marker or :managed preamble — delete
    }
    kept.push(line);
  }
  return kept.join("\n");
}
