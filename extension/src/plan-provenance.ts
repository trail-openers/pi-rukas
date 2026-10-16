/**
 * plan-provenance — #1377: caller-supplied labels + provenance on a filed issue.
 *
 * An automated caller (a host loop that reads run transcripts and files bugs it
 * finds) must make its tickets distinguishable from manually filed work, and the
 * marker must be present FROM THE FIRST MOMENT: inside pi every role is refused
 * `gh issue create`, so a caller cannot add a label itself, and a follow-up
 * `gh issue edit` leaves a window where the issue looks manual to the work
 * driver's backlog and the operator's queries that read the tracker continuously.
 * Hence three things, all owned by CODE and none by an LLM stage:
 *
 *   - `normalizeLabels` / `validateProvenance` — the pre-dispatch input gate
 *     (plan-tool.ts calls them before any dispatch is paid for),
 *   - `renderProvenance` — the two lines the code appends to the body AFTER
 *     `fitDraftToBudget` (the first line italic, the last an HTML comment with
 *     the pairs in sorted key order),
 *   - `provenanceReservation` — the char count subtracted from the render budget
 *     so the final body still fits the forge's 65,536-char cap.
 *
 * The lines are appended after drafting and reservation-budgeted, which is what
 * makes them survive compaction: the compaction fitter never sees them and can
 * never trim them, and the reservation is the only thing that has to be planned
 * around. With no `provenance` the reservation is 0 and the body is byte-for-byte
 * what it was before this feature.
 */

/** At most five labels per filing — the gh/glab create call stays one argv line. */
export const MAX_LABELS = 5;

/** A label name: 1–50 chars, starts alphanumerically, may contain spaces and `:`. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9:._ /-]*$/;

/** Marker keys: a lowercase slug, at most 32 chars. */
const MARKER_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Marker values: conservative enough that a rendered pair can never break out
 * of the HTML comment or read as markup. `@` IS allowed here (an account handle
 * in a value is the point — `run=hermes-cron`, `actor=ops@host`); the account
 * prohibition is on `line` only, which renders as visible text.
 */
const MARKER_VALUE_RE = /^[A-Za-z0-9._,:/#@+=-]{1,200}$/;

/** At most 16 pairs, and one line of at most 300 chars. */
export const MAX_MARKER_PAIRS = 16;
export const MAX_PROVENANCE_LINE = 300;

/**
 * Characters a provenance line may never carry. `@` / `<` / `>` and the
 * backtick are REJECTED rather than escaped: the line is rendered into an issue
 * body a human reads, so a caller that wants to mention an account has to say
 * so in a field the reviewer can see, and an escaped `<script>` is exactly the
 * "we escaped it for you" trap this refuses.
 */
const FORBIDDEN_LINE_CHARS = /[@<>`]/;

export interface PlanProvenance {
  /** One line of visible text, rendered italic as the body's FIRST line. */
  line: string;
  /** Structured pairs, rendered as an HTML comment on the body's LAST line. */
  marker: Record<string, string>;
}

/** A caller-supplied input shape — nothing here is trusted until validated. */
export function isLabelArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isProvenanceShape(v: unknown): v is PlanProvenance {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.line !== "string") return false;
  if (!o.marker || typeof o.marker !== "object" || Array.isArray(o.marker)) return false;
  return Object.values(o.marker as Record<string, unknown>).every((x) => typeof x === "string");
}

/**
 * Validate the labels a caller passed. Returns the trimmed list in the order
 * given, or the names of what is wrong — the caller turns that into a named
 * error BEFORE any dispatch. Blank entries are ignored; duplicates are collapsed.
 */
export function normalizeLabels(
  labels: unknown,
): { ok: true; labels: string[] } | { ok: false; problems: string[] } {
  if (!isLabelArray(labels)) {
    return { ok: false, problems: ["labels must be an array of strings"] };
  }
  const problems: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim();
    if (label === "") continue;
    if (label.length > 50) {
      problems.push(`label "${label.slice(0, 50)}…" is over 50 chars`);
    } else if (!LABEL_RE.test(label)) {
      problems.push(
        `label "${label}" must start alphanumeric and match ^[A-Za-z0-9][A-Za-z0-9:._ /-]*$`,
      );
    } else if (!seen.has(label)) {
      seen.add(label);
      kept.push(label);
    }
  }
  if (kept.length > MAX_LABELS) {
    problems.unshift(`at most ${MAX_LABELS} labels are allowed (got ${kept.length})`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, labels: kept };
}

/**
 * Validate the provenance object a caller passed. Returns the normalized shape
 * or the problems; nothing renders until this returns ok.
 */
export function validateProvenance(
  v: unknown,
): { ok: true; provenance: PlanProvenance } | { ok: false; problems: string[] } {
  if (!isProvenanceShape(v)) {
    return {
      ok: false,
      problems: ["provenance must be { line: string, marker: Record<string, string> }"],
    };
  }
  const problems: string[] = [];
  const line = v.line.trim();
  if (line === "") {
    problems.push("provenance.line is empty");
  } else if (line.length > MAX_PROVENANCE_LINE) {
    problems.push(
      `provenance.line is ${line.length} chars, over the ${MAX_PROVENANCE_LINE}-char limit`,
    );
  } else if (FORBIDDEN_LINE_CHARS.test(line)) {
    problems.push(
      "provenance.line contains a forbidden character (@, <, > or backtick) — it is rejected, not escaped",
    );
  }
  const entries = Object.entries(v.marker);
  if (entries.length > MAX_MARKER_PAIRS) {
    problems.push(
      `provenance.marker has ${entries.length} pairs, over the ${MAX_MARKER_PAIRS}-pair limit`,
    );
  }
  for (const [k, val] of entries) {
    if (!MARKER_KEY_RE.test(k)) {
      problems.push(`provenance.marker key "${k}" must match ^[a-z][a-z0-9_-]{0,31}$`);
    }
    if (!MARKER_VALUE_RE.test(val)) {
      problems.push(
        `provenance.marker value for "${k}" must match ^[A-Za-z0-9._,:/#@+=-]{1,200}$ (no spaces, newlines, or markup)`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  // Sort once, here: the rendered marker order is then a property of this
  // module, not of the caller's object key order or of the digest.
  const marker: Record<string, string> = {};
  for (const [k, val] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) marker[k] = val;
  return { ok: true, provenance: { line, marker } };
}

/** The comment prefix identifying a pi-rukas provenance marker. */
export const PROVENANCE_MARKER_PREFIX = "<!-- pi-rukas:provenance v1";

/** The rendered marker line: pairs in sorted key order, one HTML comment. */
export function markerLineOf(provenance: PlanProvenance): string {
  const pairs = Object.entries(provenance.marker).map(([k, v]) => `${k}=${v}`);
  return pairs.length === 0
    ? `${PROVENANCE_MARKER_PREFIX} -->`
    : `${PROVENANCE_MARKER_PREFIX} ${pairs.join(" ")} -->`;
}

/** The rendered provenance line: italic, one line, caller text verbatim. */
export function provenanceLineOf(provenance: PlanProvenance): string {
  return `_${provenance.line}_`;
}

/** The two rendered lines as the body would carry them (line, blank, …, marker). */
export function renderProvenance(provenance: PlanProvenance | undefined): {
  firstLine: string;
  lastLine: string;
} {
  if (!provenance) return { firstLine: "", lastLine: "" };
  return { firstLine: provenanceLineOf(provenance), lastLine: markerLineOf(provenance) };
}

/**
 * The char count the budget fitter must reserve for the provenance lines:
 * the italic line, the blank line after it, the blank separator before the
 * marker and the marker itself — plus 4 chars of slack for the join newlines.
 * 0 when no provenance was passed, which is what keeps an existing caller's
 * budget — and therefore its body — byte-identical.
 */
export function provenanceReservation(provenance: PlanProvenance | undefined): number {
  if (!provenance) return 0;
  return provenanceLineOf(provenance).length + markerLineOf(provenance).length + 4;
}

/**
 * Wrap a drafted body with the caller's provenance: the italic line as the
 * FIRST line followed by a blank line, the marker comment as the LAST line.
 * Appended by code after drafting — never by an LLM stage — so what the
 * operator reviewed is exactly what the forge receives.
 */
export function withProvenance(body: string, provenance: PlanProvenance | undefined): string {
  if (!provenance) return body;
  const { firstLine, lastLine } = renderProvenance(provenance);
  return `${firstLine}\n\n${body}\n\n${lastLine}`;
}
