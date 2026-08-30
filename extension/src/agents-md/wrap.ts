/**
 * wrap — the brownfield wrap: bytes in → wrapped bytes out. Pure.
 *
 * A repo that already has an `AGENTS.md` written by humans (no pi-ensemble
 * markers) cannot be `create`d (the verb refuses an existing file) and cannot
 * be `update`d in place (there are no marker spans to splice). The wrap is
 * the third option: leave every original line exactly where it is, insert
 * marker pairs around the sections the core can re-derive (`machine`), and
 * append the managed sections detection can derive plus a `decision-ledger`.
 *
 * ## The insertions-only invariant
 *
 * `wrapBytes` builds the output by walking the original line by line and
 * either copying the line verbatim or emitting marker/section lines around
 * it. No original line is ever deleted, reworded, or reordered. Because of
 * this construction the caller's "insertions-only" assertion is a check, not
 * a hope: any original line missing from the output is a bug this module
 * structurally cannot produce (the one deliberate exception: trailing blank
 * lines inside a wrapped section are dropped, which is byte-identical to
 * keeping them for every `## ` heading layout). If a future change would
 * need to delete or reword an original line, that is not a wrap — the caller
 * refuses (exit 2).
 *
 * ## Classification is a heuristic; the default is doctrine
 *
 * Each existing `## ` section is classified as:
 *   - `machine` — a heading naming a managed id AND content in that id's
 *     shape. Wrapped in marker pairs; the core's update path re-derives it.
 *   - `ambiguous` — a managed-id heading whose content does not match the
 *     id's shape (or machine-shaped content under a non-managed heading).
 *     Reported to the caller, which surfaces exit 1 with a finding per
 *     section so the PM runs the numbered-list protocol.
 *   - `doctrine` — everything else. Left exactly where it is, byte-identical.
 *
 * The classification never rewords a heading: `quality gates`, `quality_
 * gates`, `Quality-Gates` and `## Quality Gates` all name the same managed
 * id. A heading that only *resembles* a managed id ("Quality", "My Commands")
 * is NOT one — it stays doctrine.
 *
 * A managed id with NO heading at all is `add`: it is appended (not wrapped)
 * only when detection can derive its body.
 */

import type { DetectedFacts } from "./detect.ts";
import { type LedgerRow, renderLedger } from "./ledger.ts";
import { MARKER_VERSION } from "./markers.ts";

/** A refusal from the wrap: the caller maps this to exit 2. */
export class WrapError extends Error {}

export type WrapClassification = "machine" | "doctrine" | "ambiguous";

export interface WrapSection {
  /** The heading line, verbatim (e.g. `## Commands`). */
  heading: string;
  /** Index of the heading line in the original (0-based). */
  headingLine: number;
  /** Indices of the content lines (after the heading, before the next ##). */
  contentLines: number[];
  classification: WrapClassification;
  /** The managed id this section maps to, when the heading names one. */
  id?: string;
}

export interface WrapResult {
  bytes: string;
  sections: WrapSection[];
  /** Managed ids appended because no section with that heading existed. */
  appended: string[];
  /** Sections left untouched (doctrine). */
  doctrine: WrapSection[];
  /** Sections wrapped in place. */
  wrapped: WrapSection[];
}

const MANAGED_IDS = ["quality-gates", "commands", "environment"] as const;

/** Map a heading's words to a managed section id, or undefined. */
export function headingToId(heading: string): string | undefined {
  const words = heading
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[_.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // (No minimum length: "## Commands" is a single word, and it names a
  //  managed id. "## Quality" alone does not, because the check below is
  //  per-id, not per-keyword.)
  // Exact word sets only — a heading is machine when it NAMES the section,
  // not when it merely contains a keyword ("My Quality Rules" is doctrine).
  if (words[0] === "quality" && words[1] === "gates") return "quality-gates";
  if (words.length === 1 && (words[0] === "commands" || words[0] === "command")) return "commands";
  if (words.length === 1 && (words[0] === "environment" || words[0] === "environments"))
    return "environment";
  return undefined;
}

/** Whether a section's content looks like the core's own output for `id`. */
function contentMatchesId(id: string, text: string): boolean {
  if (id === "quality-gates") {
    return /Run these before pushing/.test(text) && /-\s+\*\*.*\*\*\s+—\s+`.*`/.test(text);
  }
  if (id === "commands") {
    return /^\|\s*kind\s*\|\s*command\s*\|/m.test(text);
  }
  if (id === "environment") {
    return /-\s+Manifest:\s+`/.test(text);
  }
  return false;
}

/** Split the original into lines and find every top-level `## ` section. */
export function findSections(original: string): WrapSection[] {
  const lines = original.split("\n");
  const sections: WrapSection[] = [];
  let current: WrapSection | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = {
        heading: line,
        headingLine: i,
        contentLines: [],
        classification: "doctrine",
        id: headingToId(line),
      };
    } else if (current) {
      current.contentLines.push(i);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Classify every `## ` section. Pure: `original` in, classified list out.
 * The default is doctrine; ambiguity is reported, never guessed.
 */
export function classifySections(original: string): WrapSection[] {
  const lines = original.split("\n");
  const sections = findSections(original);
  for (const s of sections) {
    const text = s.contentLines.map((i) => lines[i] ?? "").join("\n");
    if (s.id && contentMatchesId(s.id, text)) s.classification = "machine";
    else if (s.id || MANAGED_IDS.some((mid) => contentMatchesId(mid, text)))
      s.classification = "ambiguous";
    // else doctrine
  }
  return sections;
}

function markerBegin(id: string): string {
  return `<!-- pi-ensemble:agents-md:begin ${id} v${MARKER_VERSION} -->`;
}
function markerEnd(id: string): string {
  return `<!-- pi-ensemble:agents-md:end ${id} -->`;
}

/**
 * Produce the wrapped bytes. Throws WrapError when:
 *   - any section is ambiguous (caller: exit 1 + a finding per section)
 *   - nothing is classifiable and nothing is derivable (caller: exit 2)
 */
export function wrapBytes(
  original: string,
  facts: DetectedFacts,
  bodies: { id: string; body: string }[],
  ledger: LedgerRow[],
  scaffoldBodies?: { id: string; body: string }[],
): WrapResult {
  void facts;
  const sections = classifySections(original);
  const lines = original.split("\n");

  const ambiguous = sections.filter((s) => s.classification === "ambiguous");
  if (ambiguous.length > 0) {
    throw new WrapError(
      `ambiguous classification for section(s): ${ambiguous
        .map((s) => s.heading)
        .join(", ")} — run the numbered-list protocol`,
    );
  }

  const machineByLine = new Map<number, WrapSection>();
  for (const s of sections) {
    if (s.classification === "machine" && s.id) machineByLine.set(s.headingLine, s);
  }
  const wrappedIds = new Set(
    [...machineByLine.values()].map((s) => s.id).filter((x): x is string => x !== undefined),
  );
  const appended = bodies.filter((b) => !wrappedIds.has(b.id));

  // Wrap refusal: no machine sections, no derivable bodies, and no scaffold
  // sections to append. When scaffold is enabled (scaffoldBodies.length > 0),
  // the refusal is lifted because boilerplate will be appended. This is the
  // Shape C hybrid design: boilerplate sections live outside markers and the
  // wrap refuses only when nothing at all can be produced.
  const scaffoldCount = scaffoldBodies?.length ?? 0;
  if (machineByLine.size === 0 && appended.length === 0 && scaffoldCount === 0) {
    throw new WrapError(
      "no section is classifiable as machine and no managed section is derivable — refusing to wrap",
    );
  }

  const out: string[] = [];
  const nextHeading = new Map<number, number>(); // heading line -> contentEnd + 1
  for (const s of sections) {
    const last = s.contentLines[s.contentLines.length - 1];
    nextHeading.set(s.headingLine, (last === undefined ? s.headingLine : last) + 1);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sec = machineByLine.get(i);
    if (sec) {
      // Emit the section (heading, begin marker, verbatim content lines, end
      // marker) exactly once, then skip the content lines in the walk — a
      // second emission would duplicate bytes and break insertions-only.
      out.push(line);
      out.push(markerBegin(sec.id as string));
      for (const cl of sec.contentLines) {
        // Verbatim, blanks and all — the insertions-only invariant does not
        // permit even deleting a blank.
        out.push(lines[cl] ?? "");
      }
      out.push(markerEnd(sec.id as string));
      i = (nextHeading.get(i) ?? i + 1) - 1;
    } else {
      out.push(line);
    }
  }

  const appendBlock: string[] = [];
  for (const b of appended) {
    appendBlock.push(
      markerBegin(b.id),
      b.body.endsWith("\n") ? b.body : `${b.body}\n`,
      markerEnd(b.id),
    );
  }
  appendBlock.push(
    markerBegin("decision-ledger"),
    renderLedger(ledger),
    markerEnd("decision-ledger"),
  );

  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  result += `\n${appendBlock.join("\n")}\n`;

  return {
    bytes: result,
    sections,
    appended: appended.map((b) => b.id),
    doctrine: sections.filter((s) => s.classification === "doctrine"),
    wrapped: [...machineByLine.values()],
  };
}

/**
 * The ledger rows a wrap must emit: one `[auto]` row recording the wrap
 * itself (keeps the section non-empty for check's empty-section guard and
 * gives the ledger a home for subsequent operator answers) plus the standard
 * omission rows for managed sections detection could not derive.
 */
export function wrapLedgerRows(
  today: string,
  omissionReasons: { id: string; reason: string }[],
): LedgerRow[] {
  const rows: LedgerRow[] = [
    { key: "brownfield-wrap", value: "wrapped", provenance: "auto", date: today },
  ];
  for (const o of omissionReasons) {
    rows.push({ key: `omit:${o.id}`, value: o.reason, provenance: "auto", date: today });
  }
  return rows;
}

/**
 * Whether every non-blank line of `original` survives verbatim, in order, in
 * `wrapped` — the insertions-only property, checked against real bytes. Marker
 * and append lines are insertions BETWEEN original lines, so the scan advances
 * past them rather than treating one as a reworded original line.
 */
export function isInsertionsOnly(original: string, wrapped: string): boolean {
  const outLines = wrapped.split("\n").filter((l) => l.trim() !== "");
  let k = 0;
  for (const l of original.split("\n")) {
    if (l.trim() === "") continue;
    while (k < outLines.length && outLines[k] !== l) k++;
    if (k >= outLines.length || outLines[k] !== l) return false;
    k++;
  }
  return true;
}
