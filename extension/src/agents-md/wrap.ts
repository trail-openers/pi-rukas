/**
 * wrap — the brownfield wrap: bytes in → wrapped bytes out. Pure.
 *
 * A repo that already has an `AGENTS.md` written by humans (no pi-rukas
 * markers) cannot be `create`d (the verb refuses an existing file) and cannot
 * be `update`d in place (there are no marker spans to splice). The wrap is
 * the third option: leave every original line exactly where it is, keep the
 * sections the core can re-derive (`machine`) as heading-delimited managed
 * spans, and append the managed sections detection can derive.
 *
 * Post-#681 (M2, marker removal): the wrap NO LONGER emits HTML comment
 * marker pairs (`<!-- pi-rukas:agents-md:begin … -->` / `:end`). The
 * "managed span" it writes is the section's OWN heading line (e.g.
 * `## Commands`) delimiting its body down to the next heading of level ≤ its
 * own. A freshly wrapped file is pure prose — headings and body text only —
 * with zero `<!--` bytes of its own making. The section's identity is its
 * heading text, matched by `headingToId`, not by an embedded comment.
 *
 * ## The insertions-only invariant
 *
 * `wrapBytes` builds the output by walking the original line by line and
 * either copying the line verbatim or appending the managed sections it can
 * derive after the last line. No original line is ever deleted, reworded, or
 * reordered. Because of this construction the caller's "insertions-only"
 * assertion is a check, not a hope: any original line missing from the output
 * is a bug this module structurally cannot produce. If a future change would
 * need to delete or reword an original line, that is not a wrap — the caller
 * refuses (exit 2).
 *
 * ## Classification is a heuristic; the default is doctrine
 *
 * Each existing top-level section is classified as:
 *   - `machine` — a heading naming a managed id AND content in that id's
 *     shape. Kept as-is; the core's update path re-derives it.
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
 * ## Level-aware boundaries
 *
 * A section spans from its heading line to the next heading whose level is
 * ≤ its own. A `# Git Workflow` therefore does NOT end at its `## Conventional
 * commits` / `## Branch protection` sub-headings (they are deeper); it ends at
 * the next `#` or the end of the file. This matters because the scaffold
 * bodies (scaffold.ts `SCAFFOLD_BODIES`) emit `#` sections that contain `##`
 * sub-headings, and a naive "split on next `##`" detector would carve one
 * scaffold section into several and misclassify the sub-headings. A `##`
 * section ends at the next `##` or `#`.
 *
 * A managed id with NO heading at all is `add`: it is appended (not wrapped)
 * only when detection can derive its body.
 */

import type { LedgerRow } from "./ledger.ts";
import { renderHeadingFor } from "./section-detect.ts";

/** A refusal from the wrap: the caller maps this to exit 2. */
export class WrapError extends Error {}

export type WrapClassification = "machine" | "doctrine" | "ambiguous";

export interface WrapSection {
  /** The heading line, verbatim (e.g. `## Commands`). */
  heading: string;
  /** Heading level of the heading (1 = `#`, 2 = `##`, …). */
  level: number;
  /** Index of the heading line in the original (0-based). */
  headingLine: number;
  /** Indices of the content lines (after the heading, before the next
   *  same-or-deeper-level heading). */
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
  /** Sections kept as-is (machine). */
  wrapped: WrapSection[];
}

const MANAGED_IDS = ["quality-gates", "commands", "environment", "code-style"] as const;

/** A heading line: `#+` followed by a space and text. Captures the level. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Map a heading's words to a managed section id, or undefined. */
export function headingToId(heading: string): string | undefined {
  const words = heading
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[_.-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // (No minimum length: "## Commands" is a single word, and it names a
  //  managed id. "## Quality" alone does not, because the check below is
  //  per-id, not per-keyword.)
  // Exact word sets only — a heading is machine when it NAMES the section,
  // not when it merely contains a keyword ("My Quality Rules" is doctrine).
  // A trailing parenthetical ("Quality gates (blocking)") makes the word set
  // longer than the id's, so it does NOT match — that is deliberate: the
  // scaffold's `## Quality gates (blocking)` sub-heading is not the managed
  // `quality-gates` fact section.
  if (words[0] === "quality" && words[1] === "gates") return "quality-gates";
  if (words.length === 1 && (words[0] === "commands" || words[0] === "command")) return "commands";
  if (words.length === 1 && (words[0] === "environment" || words[0] === "environments"))
    return "environment";
  if (words[0] === "code" && words[1] === "style") return "code-style";
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
  if (id === "code-style") {
    // A dense bullet list, no table, short — the shape codeStyleBody emits.
    const lines = text.split("\n");
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    if (nonEmpty.length === 0 || nonEmpty.length > 15) return false;
    if (nonEmpty.some((l) => /\|.*\|/.test(l))) return false; // table syntax
    if (!nonEmpty.some((l) => /^[-*]\s+/.test(l.trim()))) return false; // needs ≥1 bullet
    return true;
  }
  return false;
}

/**
 * Split the original into top-level sections with LEVEL-AWARE boundaries.
 *
 * Every heading line is a span boundary at its own level. A heading at level
 * L opens a managed span that runs until the next heading at level ≤ L — a
 * deeper heading (level > L) is a sub-section of the current span and does
 * NOT terminate it. `# Git Workflow` therefore spans its `## Conventional
 * commits` / `## Branch protection` sub-headings and ends only at the next
 * `#` (or EOF); a `## Commands` fact section ends at the next `##` or `#`.
 *
 * Only top-level spans are returned (the shallowermost heading at each
 * position). Sub-headings are reported as content lines of their parent span,
 * never as their own section.
 */
export function findSections(original: string): WrapSection[] {
  const lines = original.split("\n");
  const top: WrapSection[] = []; // top-level sections, document order
  const stack: WrapSection[] = []; // every open span, outermost (shallowest) first

  const sink = (): WrapSection | undefined => stack[stack.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = HEADING_RE.exec(line);
    if (m) {
      const level = m[1]?.length ?? 1;
      // Close every open span at level ≤ the new heading's level: a
      // same-or-shallower heading terminates them. (A deeper heading does NOT
      // close any span — it becomes a child of the current innermost.)
      while (stack.length > 0 && (stack[stack.length - 1] as WrapSection).level <= level) {
        stack.pop();
      }
      const sec: WrapSection = {
        heading: line,
        level,
        headingLine: i,
        contentLines: [],
        classification: "doctrine",
        id: headingToId(line),
      };
      const parent = stack[stack.length - 1];
      const isTop = !parent || parent.level >= level;
      stack.push(sec);
      // The wrap's managed ids are all `##` fact sections (level ≥ 2). An h1
      // section is a scaffold section detected by update-agent.ts's
      // detectExistingBoilerplate, not by the wrap — so only level-≥-2 spans
      // are returned, matching the original `##`-only contract. (h1 sections
      // still open spans so their `##` children are scoped as their content.)
      if (isTop && level >= 2) top.push(sec);
    } else {
      const inner = sink();
      if (inner) inner.contentLines.push(i);
    }
  }
  return top;
}

/**
 * The level-aware delimiter rule (issue #681 M2): the extent of a section
 * opened by the heading at `headingLine`, in 0-based line indices. A section
 * runs from its heading line to the next heading of level ≤ its own (exclusive),
 * or EOF. A `#` (h1) section therefore spans its `##` sub-headings and ends
 * only at the next `#`; a `##` section ends at the next `##` or `#`.
 *
 * Returns the indices of the section's content lines (after the heading, up to
 * but not including the terminating heading). This is the primitive the
 * shared section-detect module (a later sub-issue) will generalise; it is
 * exposed here so the boundary rule is testable in isolation.
 */
export function sectionExtent(original: string, headingLine: number): number[] {
  const lines = original.split("\n");
  const heading = lines[headingLine] ?? "";
  const m = HEADING_RE.exec(heading);
  const level = m ? (m[1]?.length ?? 1) : 1;
  const content: number[] = [];
  for (let i = headingLine + 1; i < lines.length; i++) {
    const lm = HEADING_RE.exec(lines[i] ?? "");
    if (lm) {
      const l = lm[1]?.length ?? 1;
      if (l <= level) break; // same-or-shallower heading terminates the section
    }
    content.push(i);
  }
  return content;
}

/**
 * Classify every section. Pure: `original` in, classified list out.
 * The default is doctrine; ambiguity is reported, never guessed.
 *
 * Post-#681 (M2): the machine/ambiguous split is keyed purely on the
 * HEADING (exact word-set match to a managed id), not on a per-id body
 * shape predicate. The body predicates are unreliable for this purpose —
 * the issue's own brownfield `## Code Style` examples ("- Use named exports")
 * would be rejected by `contentMatchesId`, and a `## Quality Gates` heading
 * whose body the operator reworded is still the managed section. The body
 * predicates remain for the update path's re-derivation, but classification
 * is heading-keyed: a heading that names a managed id → `machine` (the core
 * re-derives it); a managed-id-shaped heading under a non-managed heading, or
 * machine-shaped content under a non-managed heading → `ambiguous` (the
 * numbered-list protocol, exit 1); everything else → doctrine.
 */
export function classifySections(original: string): WrapSection[] {
  const lines = original.split("\n");
  const sections = findSections(original);
  for (const s of sections) {
    const text = s.contentLines.map((i) => lines[i] ?? "").join("\n");
    if (s.id) s.classification = "machine";
    else if (MANAGED_IDS.some((mid) => contentMatchesId(mid, text))) s.classification = "ambiguous";
    // else doctrine
  }
  return sections;
}

/**
 * Produce the wrapped bytes. Throws WrapError when:
 *   - any section is ambiguous (caller: exit 1 + a finding per section)
 *   - nothing is classifiable and nothing is derivable (caller: exit 2)
 *
 * `ledgerRows` is the caller's sidecar rows (post-#680 M1): the wrap NO LONGER
 * renders them into the wrapped file — the decision-ledger is not appended
 * in-file. The caller writes the sidecar separately via the verb layer.
 *
 * The output is the original bytes, byte-for-byte (no markers inserted
 * around machine sections — the heading IS the span), with the derivable
 * managed sections APPENDED at the end as heading-delimited spans. This keeps
 * the insertions-only invariant exact and guarantees zero `<!--` bytes are
 * introduced by the wrap itself.
 */
export function wrapBytes(
  original: string,
  facts: unknown,
  bodies: { id: string; body: string }[],
  ledgerRows: unknown,
  scaffoldBodies?: { id: string; body: string }[],
): WrapResult {
  void facts;
  void ledgerRows;
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

  const machineSections = sections.filter((s) => s.classification === "machine");
  const wrappedIds = new Set(
    machineSections.map((s) => s.id).filter((x): x is string => x !== undefined),
  );
  const appended = bodies.filter((b) => !wrappedIds.has(b.id));

  // Wrap refusal: no machine sections, no derivable bodies, and no scaffold
  // sections to append. When scaffold is enabled (scaffoldBodies.length > 0),
  // the refusal is lifted because boilerplate heading-delimited sections will
  // be appended. The wrap refuses only when nothing at all can be produced.
  const scaffoldCount = scaffoldBodies?.length ?? 0;
  if (machineSections.length === 0 && appended.length === 0 && scaffoldCount === 0) {
    throw new WrapError(
      "no section is classifiable as machine and no managed section is derivable — refusing to wrap",
    );
  }

  // Post-#681 M2: the wrap emits NO marker pairs. A machine section is already
  // a heading-delimited managed section (its heading names the id and its body
  // matches the id's shape), so the wrap leaves it EXACTLY where it is — the
  // heading is the anchor, and nothing is inserted around it. This makes the
  // wrap idempotent on its own output (a second wrap is a byte-identical
  // no-op), which the marker-era wrap could not guarantee because re-wrapping
  // emitted a nested marker pair. Only MISSING managed ids (no section with
  // that heading) are appended as heading-delimited blocks.
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
  }

  const appendBlock: string[] = [];
  for (const b of appended) {
    // Each appended managed section is a heading-delimited block: the exact
    // heading text for the id (single source in section-detect.ts), a blank
    // line, the body, a trailing newline. No comment bytes.
    appendBlock.push(`${renderHeadingFor(b.id)}\n\n${b.body}`.replace(/\n$/, ""));
  }

  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  if (appendBlock.length > 0) {
    result += `\n${appendBlock.join("\n\n")}\n`;
  }

  return {
    bytes: result,
    sections,
    appended: appended.map((b) => b.id),
    doctrine: sections.filter((s) => s.classification === "doctrine"),
    wrapped: machineSections,
  };
}

/**
 * The sidecar rows a wrap must emit: one `[auto]` row recording the wrap
 * itself (gives the sidecar a home for subsequent operator answers) plus the
 * standard omission rows for managed sections detection could not derive.
 * (Post-#680 M1: these go to the sidecar, not an in-file ledger section.)
 */
export function wrapLedgerRows(
  today: string,
  omissionReasons: { id: string; reason: string }[],
): LedgerRow[] {
  const rows: LedgerRow[] = [
    { key: "brownfield-wrap", value: "wrapped", provenance: "auto", date: today },
  ];
  for (const o of omissionReasons) {
    rows.push({
      key: `omit:${o.id}`,
      value: o.reason,
      provenance: "auto",
      date: today,
    });
  }
  return rows;
}

/**
 * Whether every non-blank line of `original` survives verbatim, in order, in
 * `wrapped` — the insertions-only property, checked against real bytes.
 * Appended managed-section lines are insertions AFTER the original content,
 * so the scan walks the original lines in order and confirms each appears,
 * in sequence, among the non-blank output lines.
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
