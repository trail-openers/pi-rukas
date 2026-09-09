/**
 * plan-writeback — the Decision-A writeback for carried gap-gate resolutions
 * (issue #639, defect 2).
 *
 * When a corrective round carries a blocking (CRITICAL) gap whose proposed
 * resolution can be applied to the spec body, the resolution is WRITTEN BACK
 * into a rendered section (a new bullet there) and the Open Questions bullet
 * renders status resolved. When it cannot (the parseGaps placeholder, or a
 * resolution naming no renderable section), the bullet renders status open
 * with decision owner operator and the body is left unmodified. The status
 * comes from this structured output, never from a string-prefix test of the
 * question text (the old resolved-prefix renderer is deleted).
 *
 * Split out of plan-draft.ts (500-line hard limit, AGENTS.md section 12).
 * The matching is deliberately conservative and mechanical (Decision A):
 * case-insensitive containment of the rendered section headings.
 *
 * Six-lens re-review (PR #640), ARCHITECTURE lens: the responsibilities
 * split. `writebackGapToBody` USED to take the current body, splice a
 * bullet into it, and return the mutated body — but its only caller
 * (plan-driver.ts onCorrective) discarded that body: the very next
 * statement re-assigned it from draftSpec, which rebuilds the body from
 * scratch and applies the writeback itself. The splice was dead work
 * (PERFORMANCE lens), and `writtenBack` was decided against the discarded
 * body yet later rendered against the rebuilt one — a flag predicting a
 * write instead of recording one (TYPE_SAFETY lens). The split: this
 * module RESOLVES destinations (where a resolution would go) and renders;
 * draftSpec is the SINGLE site that actually splices, and it reports back
 * which splices landed so the flag is produced BY the write.
 */
// GAP_RESOLUTION_PLACEHOLDER is declared ONCE in plan-gaps.ts (which owns
// parseGaps — the parser that assigns the sentinel) and imported here so the
// branch-3 comparison below keys on the EXACT string the parser writes:
// a parser-side rename must flip both files at once, not silently drift.
// plan-gaps.ts imports nothing from this module, so the dependency is one-way.
import { GAP_RESOLUTION_PLACEHOLDER } from "./plan-gaps.ts";
import type { PlanGap, PlanType } from "./plan-types.ts";

/**
 * The headings a carried resolution may name as its writeback destination.
 * The winner is the entry whose match occurs EARLIEST IN THE RESOLUTION
 * TEXT — not array order (vipune fixture run, C4: array-order matching
 * routed "…acceptance criterion … remove the contradictory test surface
 * language" to Test surface because that entry sat earlier in the list,
 * and the bullet rendered falsely "resolved" under the wrong heading).
 *
 * The AC entry matches the SINGULAR "acceptance criterion" too — the gate
 * prompt's own resolution template says "(b) a sharper acceptance
 * criterion to add", so template-conformant resolutions used to match
 * nothing and fall to branch 3 (never applied). Hyphenated forms are
 * accepted throughout. The spike "Expected deliverable" heading is matched
 * by the same entry as "Acceptance criteria" (residual gap-gate finding 3,
 * #639); "Sub-issues" is writable for epics — a heading absent from the
 * rendered body (non-epic types) simply reports not-applied and the bullet
 * renders status open, per Decision A branch 1.
 */
const WRITABLE_SECTIONS: { heading: string; re: RegExp }[] = [
  { heading: "Out of scope", re: /out[ -]of[ -]scope/i },
  { heading: "Test surface", re: /test[ -]surface/i },
  { heading: "Edge cases", re: /edge[ -]cases/i },
  { heading: "References", re: /references/i },
  { heading: "Sub-issues", re: /sub[ -]issues?/i },
  {
    heading: "Acceptance criteria",
    re: /acceptance criteri(?:a|on)|expected deliverable/i,
  },
];

/**
 * The default destination heading for a carried resolution: the
 * acceptance-criteria heading for non-spike types, the Expected-deliverable
 * heading for spikes (Decision A, residual finding 3 — spike is the only
 * type with no "Acceptance criteria" heading). The bullet is appended under
 * the type's ACTUAL rendered heading (the spike deliverable line carries a
 * trailing parenthetical), so this must match what draftSpec renders;
 * appendBulletsToSection matches the heading as a prefix, not the full line.
 */
export function defaultDestinationHeading(type: PlanType): string {
  return type === "spike" ? "Expected deliverable" : "Acceptance criteria";
}

/**
 * The structured record of one resolved decision passed to draftSpec as the
 * new separate parameter (Decision B): the gap's description (the Open
 * Questions bullet text) plus a decision on where its resolution went.
 *
 * NOTE (six-lens re-review, PR #640, TYPE_SAFETY lens): the `writtenBack`
 * and `writebackHeading` fields on the INPUT record are DEAD — the splice
 * that would have justified them moved out of the onCorrective closure into
 * draftSpec, so nothing reads them. The driver's onCorrective builds these
 * records without the fields (buildResolvedDecisions). They stay on the
 * interface only because draftSpec still writes them on the RETURNED
 * records (draftSpec's return type is this same interface). Removing them
 * would mean a separate input/return type split — deferred; the field is
 * inert, and removing it is a one-line change when that split happens.
 */
export interface ResolvedDecision {
  /** The Open Questions bullet text (the gap description). */
  description: string;
  /**
   * True when the resolution was written back into a section of the body.
   * Set by draftSpec AFTER the splice (the flag is produced by the write,
   * not predicted before it). Not set by callers.
   */
  writtenBack?: boolean;
  /**
   * The resolution text (always present — when not written back, the bullet
   * still names the resolution so the operator can see it was not applied).
   */
  resolution: string;
  /**
   * The section heading the resolution bullet was written back to
   * (draftSpec sets this on the RETURNED record after the splice lands —
   * the bullet is part of the re-draft, not a post-hoc modification to a
   * separate body, which would be lost when draftSpec rebuilds from
   * scratch). Not set by callers.
   */
  writebackHeading?: string;
}

/** The destination a carried resolution resolves to, or null (no write). */
export interface WritebackDestination {
  /** The section heading the resolution should be spliced into. */
  heading: string;
}

/** One bullet's application outcome, reported back by the single splice. */
export interface SpliceOutcome {
  /** True when the bullet was actually appended (the heading survived rendering). */
  applied: boolean;
  /** The heading the bullet targeted (set whether applied or not). */
  heading: string;
  /** The bullet text that was (or would have been) spliced under the heading. */
  bullet: string;
}

/**
 * Resolve the destination for one carried (blocking, gate-round) gap's
 * proposed resolution per Decision A — WITHOUT touching any body (the
 * splice lives in a single site: draftSpec, see the module header).
 *
 *   1. placeholder resolution, or a resolution naming no renderable
 *      section → null: the bullet renders status open, decision owner
 *      operator, body unchanged.
 *   2. a resolution naming a renderable section → the heading it maps to
 *      (the "Acceptance criteria" entry maps to the type's actual rendered
 *      heading via defaultDestinationHeading — the spike analogue).
 *
 * The PLACEHOLDER short-circuit is FIRST on purpose (six-lens re-review,
 * PR #640, SIMPLICITY lens): branch 1's contract must not depend on the
 * sentinel text happening to name no writable section — if the placeholder
 * is ever reworded into a string that contains a heading name, section
 * matching must not suddenly give it a destination. The current sentinel
 * only works because of its wording; this ordering makes branch 1
 * unconditional.
 *
 * Matching rule (revised, vipune fixture run C4): case-insensitive
 * containment of one of the rendered section headings; the heading whose
 * match occurs at the EARLIEST POSITION in the resolution text wins — a
 * resolution's primary destination is what it names first, and later
 * mentions ("…and remove the contradictory test surface language") are
 * commentary. A resolution naming a heading that is not renderable falls
 * to branch 1.
 */
export function destinationFor(gap: PlanGap, type: PlanType): WritebackDestination | null {
  const resolution = gap.resolution;
  if (!resolution || resolution === GAP_RESOLUTION_PLACEHOLDER) return null;
  let named: { heading: string; index: number } | null = null;
  for (const s of WRITABLE_SECTIONS) {
    const m = s.re.exec(resolution);
    if (m && (named === null || m.index < named.index)) {
      named = { heading: s.heading, index: m.index };
    }
  }
  if (!named) return null;
  const heading =
    named.heading === "Acceptance criteria" ? defaultDestinationHeading(type) : named.heading;
  return { heading };
}

/**
 * Build the structured records for a corrective round's carried gaps from
 * their resolved destinations. These records travel into draftSpec; the
 * writtenBack / writebackHeading fields are NOT set here — they are
 * produced by the write itself (draftSpec reports which splices landed via
 * applyWritebackToBody's SpliceOutcome list), so a flag claiming a write
 * happened can never be predicted against a body that was discarded.
 */
export function buildResolvedDecisions(
  gaps: PlanGap[],
  type: PlanType,
): { decisions: ResolvedDecision[]; writebackMap: Map<string, string[]> } {
  const decisions: ResolvedDecision[] = [];
  const writebackMap = new Map<string, string[]>();
  for (const g of gaps) {
    const dest = destinationFor(g, type);
    decisions.push({
      description: g.description,
      resolution: g.resolution,
      ...(dest ? { writebackHeading: dest.heading } : {}),
    });
    if (dest) {
      const existing = writebackMap.get(dest.heading) ?? [];
      existing.push(g.resolution);
      writebackMap.set(dest.heading, existing);
    }
  }
  return { decisions, writebackMap };
}

/**
 * Map draftSpec's splice outcomes back onto the returned decision records:
 * writtenBack is set ONLY for the bullets the single splice actually
 * applied (a heading that did not survive rendering leaves the record
 * unwritten — the status open / decision owner operator rendering carries
 * the loss, per Decision A branch 1). The outcomes are matched by the
 * bullet text + heading pair, in the order draftSpec applied them.
 */
export function markWrittenDecisions(
  decisions: ResolvedDecision[],
  outcomes: SpliceOutcome[],
): ResolvedDecision[] {
  // Index the outcomes by (heading → list of applied bullet texts) so each
  // record is matched against exactly the splice that targeted its heading.
  const appliedByHeading = new Map<string, string[]>();
  for (const o of outcomes) {
    if (!o.applied) continue;
    const list = appliedByHeading.get(o.heading) ?? [];
    list.push(o.bullet);
    appliedByHeading.set(o.heading, list);
  }
  return decisions.map((d) => {
    if (!d.writebackHeading) return { ...d, writtenBack: false };
    const list = appliedByHeading.get(d.writebackHeading) ?? [];
    const idx = list.indexOf(d.resolution);
    if (idx === -1) return { ...d, writtenBack: false };
    list.splice(idx, 1);
    return { ...d, writtenBack: true };
  });
}

/**
 * The SINGLE section-insertion implementation (lens findings: the inline
 * writeback and the re-draft re-apply used to each re-implement "match ##
 * heading → locate section end → find last '- ' bullet → insert", and the
 * two heading regexes had diverged). The parenthetical lookahead below is
 * what keeps the spike's "Expected deliverable (NOT code — …)" line matched
 * by the prefix-only heading the writeback records, so one regex serves
 * both call sites.
 *
 * The bullet texts are passed WITHOUT the "- " prefix — this helper adds
 * the prefix (the old second implementation had re-prefixed on its own).
 * Appends AFTER the section's existing bullets (i.e. after the
 * SECTION_MAX_ITEMS slice and after sectionBullets' dedupe — a carried
 * writeback must render even when the section is full or textually
 * duplicate, residual finding 4). The section terminator is the next
 * "## " heading (or end of body). Returns null when the heading did not
 * survive rendering OR the section has no bullets to insert after.
 */
export function appendBulletsToSection(
  body: string,
  heading: string,
  bullets: string[],
): string | null {
  // The heading may carry a trailing parenthetical (the spike deliverable
  // line), so match the heading as a prefix, not the full line. The regex is
  // built with the RegExp constructor from an explicit string (avoids
  // template-literal backslash escaping in source).
  const re = new RegExp(`^## ${escapeRe(heading)}(?= [^\n]|$)`, "gm");
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nextHeading = body.indexOf("\n## ", start);
  const end = nextHeading === -1 ? body.length : nextHeading + 1;
  const section = body.slice(start, end);
  const lines = section.split("\n");
  // Find the last bullet line in the section (all lines here are bullets
  // or blanks; the fallback string is also a bullet by construction).
  let lastBullet = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trimStart().startsWith("- ")) {
      lastBullet = i;
      break;
    }
  }
  if (lastBullet === -1) return null;
  const inserted = `${body.slice(0, start) + lines.slice(0, lastBullet + 1).join("\n")}\n${bullets
    .map((b) => `- ${b}`)
    .join("\n")}${lines.slice(lastBullet + 1).join("\n")}${body.slice(end)}`;
  return inserted;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply the writeback bullets to their target sections in the rendered
 * body, delegating each heading to appendBulletsToSection (one splice
 * implementation, one heading regex — the second inline reimplementation
 * with the divergent lookahead-less regex is deleted). A heading that did
 * not survive rendering is reported as not applied (the matching decision
 * record then renders status open — the loss is visible, Decision A
 * branch 1). This is the SINGLE splice site: the SpliceOutcome list is what
 * the flag is produced from (see markWrittenDecisions), so a bullet that
 * was not actually written can never render status: resolved.
 */
export function applyWritebackToBody(
  body: string,
  writebackMap: Map<string, string[]>,
): { body: string; outcomes: SpliceOutcome[] } {
  let result = body;
  const outcomes: SpliceOutcome[] = [];
  for (const [heading, bullets] of writebackMap) {
    let applied = false;
    for (const bullet of bullets) {
      const next = appendBulletsToSection(result, heading, [bullet]);
      if (next !== null) {
        result = next;
        applied = true;
        outcomes.push({ applied: true, heading, bullet });
      }
    }
    if (!applied) outcomes.push({ applied: false, heading, bullet: bullets[0] ?? "" });
  }
  return { body: result, outcomes };
}

/**
 * Render the Open Questions section bullets from the structured resolved
 * decisions and the plain open questions. Genuinely open questions render
 * as `status: pending` with the PM as decision owner; carried decisions
 * render as `status: resolved` (the write landed — writtenBack is set by
 * draftSpec from the splice outcome) or `status: open` with
 * `decision owner: operator` (no destination, or the heading did not
 * survive rendering). The status comes from the structured record, NOT
 * from a string-prefix test.
 */
export function renderOpenQuestions(
  openQuestions: string[],
  resolvedDecisions: ResolvedDecision[],
): string {
  const openQBullets = openQuestions.map((q) => `- **${q}** — decision owner: PM; status: pending`);
  const resolvedBullets = resolvedDecisions.map((d) => {
    const status = d.writtenBack ? "resolved" : "open";
    const owner = d.writtenBack ? "PM" : "operator";
    return `- **${d.description}** — proposed resolution: ${d.resolution} (status: ${status}); decision owner: ${owner}`;
  });
  const all = [...openQBullets, ...resolvedBullets];
  return all.length > 0 ? all.join("\n") : "- (none)";
}
