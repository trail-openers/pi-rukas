#!/usr/bin/env bun
/**
 * lean/requirements — the requirement list the specify child submits, and the
 * code that decides whether each item is covered.
 *
 * The bench attributed lean's judge-rejected cells to `specify`: requirements
 * and edge cases the issue never stated, and preserved behaviours the change
 * broke. The elicitation half already exists (`IMPLIED_REQUIREMENTS` in
 * `specify-prompt.ts`); this is the half that makes it checkable — the child
 * names each requirement as an item and the tests it maps to, and a step
 * decides in code whether the mapping holds. Gate doctrine: what a child
 * CLAIMS is narration, so coverage is executed evidence, never an LLM judge.
 *
 * Three jobs, all deterministic:
 *
 *   1. {@link extractRequirements} reads the child's `submit_requirements`
 *      calls into validated items. An item whose id, kind or file list will not
 *      load refuses the WHOLE item rather than being judged half-read — a
 *      refusal would then name a requirement nobody wrote.
 *   2. {@link requirementGaps} is the coverage rule. A `behaviour` or `edge`
 *      item needs a file the pipeline proved RED for THAT item; a gap is a
 *      refusal line leading with `requirement <id> has no red test`, so the
 *      retry's 300-character clip cannot hide the reference the child needs. A
 *      `preserved` item is satisfied by an EXISTING test file (one present at
 *      the run's base, so never a file the step froze) that the step ran and
 *      found GREEN at its head — never by a red one — and a gap there is
 *      recorded with the child's own reason, never refused: the child cannot
 *      invent a project regression test that does not exist.
 *   3. {@link requirementPromptSection} renders the record into a builder's
 *      prompt, ids, kinds, text and mapped files included, so the
 *      implementation is written against the list the tests were.
 *
 * The list rides `submit_requirements`, NOT pi-spec `criteria` rows: the spec
 * is the operator's contract, which `/plan` derives and a child cannot edit,
 * while this list is the child's own account of what the issue implies.
 * `parsePiSpec` / `renderPiSpec` are untouched.
 *
 * The switch is read by the caller and passed in as an argument; a module-level
 * cache would let one run's mode leak into the next in the same process.
 */

import { pathProblem } from "./specify-path.ts";

/** The two colours a mapped test may carry in a rendered line. */
const TEST_COLOURS: readonly (keyof RequirementTest)[] = ["red", "existing", "green"];

/**
 * How a test the child named was judged, as a rendered line reads it. `red` and
 * `green` are colours the step executed for; `existing` alone is the weaker
 * claim — the file was there at the base and nobody ran it — and the reader of a
 * report must not take that for a passing regression test.
 */
function testMark(test: RequirementTest): string {
  const colour = TEST_COLOURS.find((c) => test[c] === true);
  return colour === undefined ? "unrun" : colour;
}

/** What kind of requirement an item names. */
export const REQUIREMENT_KINDS = ["behaviour", "edge", "preserved"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Requirement ids are R1, R2, … — positional, stable, greppable. */
export const REQUIREMENT_ID = /^R\d+$/;

/** One requirement item as the child submitted it. */
export interface RequirementItem {
  id: string;
  kind: RequirementKind;
  text: string;
  testFiles: string[];
  /** The child's own account of why a `preserved` item has no green test. */
  note?: string;
}

export interface RequirementExtraction {
  items: RequirementItem[];
  /** Calls (or items within a call) that named the tool but carried something unreadable. */
  skipped: number;
}

/** How many items one `submit_requirements` call may carry, and how many files one item may name. */
const MAX_ITEMS_PER_CALL = 40;
const MAX_FILES_PER_ITEM = 8;
/** One item's text (or note), clipped: child-authored prose is data, not a prompt. */
const ITEM_TEXT_MAX = 300;

/** A path the extractor can hand on: absolute, traversal-free, and a real file name. */
function usablePath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  const rel = p.trim();
  if (rel === "" || rel.includes("\0")) return false;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(rel)) return false;
  return pathProblem(rel) === undefined;
}

/** Is this one of the kinds a requirement item may name? No cast involved. */
function isKind(value: unknown): value is RequirementKind {
  return REQUIREMENT_KINDS.some((k) => k === value);
}

/** One line, clipped, or `undefined` when there is nothing to say. */
function clipped(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const one = value.replace(/\s+/g, " ").trim();
  return one === "" ? undefined : one.slice(0, ITEM_TEXT_MAX);
}

/**
 * The child's `submit_requirements` calls, as validated items.
 *
 * Mirrors `extractSubmitTests`: Pi validated the params inside the child, so
 * anything malformed here is a call the model faked rather than one it
 * accepted, and it is counted rather than trusted. A duplicate id is dropped
 * rather than judged twice — a child that listed R3 twice would otherwise be
 * refused twice for one gap, and the retry would tell it to fix something it
 * had already answered.
 */
export function extractRequirements(toolUses: unknown[]): RequirementExtraction {
  const items: RequirementItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "submit_requirements" || !t.arguments || typeof t.arguments !== "object")
      continue;
    const a = t.arguments as Record<string, unknown>;
    const raw = Array.isArray(a.requirements) ? a.requirements : [];
    // An empty or oversized list is a call this step cannot use at all: it is
    // counted once, not once per item it failed to read.
    if (raw.length === 0 || raw.length > MAX_ITEMS_PER_CALL) {
      skipped++;
      continue;
    }
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        skipped++;
        continue;
      }
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id.trim() : "";
      const text = clipped(e.text);
      const files = (Array.isArray(e.testFiles) ? e.testFiles : [])
        .filter(usablePath)
        .map((p) => p.trim())
        .slice(0, MAX_FILES_PER_ITEM);
      if (!REQUIREMENT_ID.test(id) || !isKind(e.kind) || text === undefined || files.length === 0) {
        skipped++;
        continue;
      }
      if (seen.has(id)) {
        skipped++;
        continue;
      }
      seen.add(id);
      const note = clipped(e.note);
      items.push({
        id,
        kind: e.kind,
        text,
        testFiles: files,
        ...(note === undefined ? {} : { note }),
      });
    }
  }
  return { items, skipped };
}

/** A requirement's mapped test, with what the step proved about it. */
export interface RequirementTest {
  path: string;
  /** Proven red at the step's `headBefore` — what a behaviour or edge item needs. */
  red?: boolean;
  /** Present at the run's base — what a preserved item needs, and what may never be frozen. */
  existing?: boolean;
  /** Proven green at the step's `headBefore`. */
  green?: boolean;
}

/** What the step recorded for one requirement. */
export interface RequirementRecord {
  id: string;
  kind: RequirementKind;
  text: string;
  tests: RequirementTest[];
  covered: boolean;
  /** Why it is uncovered — always the child's own reason for a `preserved` item. */
  reason?: string;
  /**
   * The refusal line this uncovered behaviour/edge item earns. Present only when
   * the step could not cover it; whether it is CHARGED to the child (a claim) or
   * merely recorded (a confession) is the caller's call, not this module's.
   */
  gap?: string;
}

/** The whole record, the form the `specify` step's outcome carries. */
export interface RequirementsRecord {
  total: number;
  byKind: Record<RequirementKind, number>;
  covered: string[];
  uncovered: string[];
  items: RequirementRecord[];
}

/** What the pipeline proved, as the caller read it. */
export interface ProvedTests {
  /** The paths the pipeline proved RED and committed, for THIS item's own list. */
  redFor: (id: string) => readonly string[];
  /** The existing (base-present) files the step ran and found GREEN at its head. */
  green: ReadonlySet<string>;
}

/** How many ids one reason line lists before it says `(+N more)`. */
const ID_LIST_CAP = 20;

/** A capped id list, so one long list cannot make a reason line unrenderable. */
export function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, ID_LIST_CAP).join(", ");
  const more = ids.length - ID_LIST_CAP;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

/**
 * The refusal line an uncovered behaviour/edge item earns. The prefix is fixed
 * and FIRST: `refusalFeedback` clips each line to 300 characters and item text
 * is child prose, so a line that opened on the text could be rendered without
 * ever naming the item the child has to fix.
 */
function gapLine(item: { id: string; text: string }): string {
  return `requirement ${item.id} has no red test: ${item.text}`;
}

/**
 * The coverage rule, in code. Pure over (the items, what the pipeline proved).
 *
 * A behaviour or edge item is covered when at least one path IT named survived
 * the pipeline as red — the caller intersects with the item's own list, so an
 * item cannot borrow a red another submission earned. A preserved item is
 * covered only by one of its own named files being green AND existing at the
 * base, which is the whole difference between "this behaviour is guarded" and
 * "this file happens to pass".
 */
export function requirementGaps(
  items: readonly RequirementItem[],
  proved: ProvedTests,
): { record: RequirementsRecord; gaps: string[] } {
  const byKind: Record<RequirementKind, number> = { behaviour: 0, edge: 0, preserved: 0 };
  const records: RequirementRecord[] = [];
  const covered: string[] = [];
  const uncovered: string[] = [];
  const gaps: string[] = [];
  for (const item of items) {
    byKind[item.kind] += 1;
    const tests: RequirementTest[] = [];
    let ok = false;
    let reason: string | undefined;
    /**
     * The refusal line an uncovered behaviour/edge item earns, kept per item so
     * the caller can tell a CLAIM (the child said it was covered — refuse the
     * round) from a CONFESSION (the child said why it is not — record it and go
     * on). `gaps` alone cannot make that distinction positional-safe.
     */
    let gap: string | undefined;
    if (item.kind === "preserved") {
      for (const p of item.testFiles) {
        const isGreen = proved.green.has(p);
        tests.push({ path: p, existing: true, ...(isGreen ? { green: true } : {}) });
        if (isGreen) ok = true;
      }
      if (!ok) reason = item.note ?? "no existing test of this behaviour is green at this head";
    } else {
      const red = proved.redFor(item.id).filter((p) => item.testFiles.includes(p));
      for (const p of item.testFiles) tests.push({ path: p, red: red.includes(p) });
      ok = red.length > 0;
      if (!ok) {
        gap = gapLine(item);
        gaps.push(gap);
      }
    }
    if (ok) covered.push(item.id);
    else uncovered.push(item.id);
    records.push({
      id: item.id,
      kind: item.kind,
      text: item.text,
      tests,
      covered: ok,
      ...(reason === undefined ? {} : { reason }),
      ...(gap === undefined ? {} : { gap }),
    });
  }
  return {
    record: { total: items.length, byKind, covered, uncovered, items: records },
    gaps,
  };
}

/**
 * The section a build child reads: the requirement list, one line per item.
 *
 * Rendered from the validated record rather than the child's raw call, so what
 * the builder sees is what the step proved, and a resumed round sees the same
 * text. The covered/uncovered mark is the record's own verdict, so a builder is
 * never told a preserved gap is a test to go and write.
 */
export function requirementPromptSection(record: RequirementsRecord): string {
  const lines = record.items.map((r) => {
    const files = r.tests.map((t) => `\`${t.path}\` (${testMark(t)})`).join(", ");
    const why = r.reason === undefined ? "" : ` — ${r.reason}`;
    return `- **${r.id}** [${r.kind}] ${r.text} → ${files === "" ? "(no test named)" : files} (${r.covered ? "covered" : "uncovered"})${why}`;
  });
  return [
    "## The requirements this run must satisfy",
    "",
    "The adversary listed these from the issue and the code it read. Each is covered, or recorded uncovered, by the test(s) named. Implement every one of them, not only the acceptance criteria.",
    "",
    ...lines,
    "",
    "An uncovered `preserved` item is a behaviour with no green regression test in this repository: do not break it, and say in your reply how you convinced yourself it still works.",
  ].join("\n");
}
