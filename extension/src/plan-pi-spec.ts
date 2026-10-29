/**
 * plan-pi-spec - the drafted /plan spec mapped onto the `pi-spec v1` contract
 * (epic #1883), so every issue the driver files carries the machine-readable
 * block the lean /work engine reads (`extension/src/lean/spec.ts`).
 *
 * Two pure exports and no I/O:
 *   - `piSpecFromDraft` - the DRAFT's own sections (`## Acceptance criteria`
 *     bullets, the `Test surface` bullets, the `Out of scope` bullets) become
 *     one `PiSpec`. It reads nothing the draft does not carry: no invented
 *     problem field, no inferred paths.
 *   - `appendPiSpecSection` - the `## Spec (pi-spec v1)` section appended to a
 *     body AFTER every compaction step, followed by the readiness line when the
 *     spec is not ready. `plan-gap-disclosure.ts` calls it as the last operation
 *     before the provenance marker wraps the body, which is what keeps
 *     compaction from ever trimming the block (the same reason the marker
 *     survives: the fitter never sees it - `piSpecReservation` is the width the
 *     budget fitter holds back so the final body still fits the forge cap).
 *
 * An epic and a spike get no block: an epic's criteria belong to its
 * sub-issues, and a spike's criteria slot is the Expected deliverable, which is
 * a decision or a proof of concept - promoting one into a verifiable criterion
 * would be a claim the draft never made.
 */
import type { PiSpec } from "./lean/spec.ts";
import { parsePiSpec, readiness, renderPiSpec } from "./lean/spec.ts";
import type { PlanType } from "./plan-types.ts";

/** The section heading the block renders under. */
export const PI_SPEC_HEADING = "## Spec (pi-spec v1)";

/** Prefix of the operator-visible readiness line. */
export const PI_SPEC_READINESS_PREFIX = "pi-spec readiness:";

/** The problem text never renders longer than this. */
export const PI_SPEC_PROBLEM_MAX_CHARS = 1_000;

/** A criterion is machine-checkable by a command when its span names one of these runners. */
const RUNNER_WORDS = [
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "pytest",
  "python",
  "make",
  "./",
];

/** One backticked span, non-greedy, never crossing a line break. */
const BACKTICK_SPAN = /`([^`\n]+)`/;

/** The size bands the contract's `size` field reports. */
const SIZE_SMALL_MAX = 3;
const SIZE_MEDIUM_MAX = 8;

/**
 * `## <heading>` ... content up to the next `## ` (or end of body).
 *
 * The pattern is assembled from plain (non-template) string literals, and that
 * is load-bearing: inside a template literal `\s` and `\S` lose their backslashes,
 * so `[\s\S]` silently becomes the class `[sS]` - which matches neither a space nor
 * a newline - and a `\n` written for a regex class becomes the two characters
 * backslash and n. Either way the lazy capture stops at the section's first
 * line, the mapper finds zero criteria, and the issue files with NO spec block
 * and no error anywhere. A regex source that must contain a backslash is built
 * from String.raw / plain literals, never from a template.
 */
const NOT_NL = String.raw`[^\n]`;
const ANY = String.raw`[\s\S]`;
const SLICE_HEAD = String.raw`^## `;
const SLICE_TAIL = String.raw`*\n`;
const SECTION_SLICE = (heading: string): RegExp =>
  new RegExp(`${SLICE_HEAD}${heading}${NOT_NL}${SLICE_TAIL}(${ANY}*?)(?=^## |$(?!${ANY}))`, "gm");

/**
 * A post-drafting disclosure heading, as a regex alternation. Built from a
 * plain (non-template) literal so the `\(` escapes and the `[^\n]` class keep their
 * backslashes.
 */
const LATER_HEADING_SOURCE = [
  "Residual gap-gate findings",
  "Open points (unresolved at the gap-gate cap)",
  "Base fallback",
  "Duplicate check",
  // The block's own heading, so a body that already carries one is bounded
  // before it and a second pass never reads the previous block as the draft.
  "Spec \\(pi-spec v1\\)",
].join("|");

/** The fields the mapper reads - all of them sections the draft really renders. */
export interface PiSpecDraft {
  type: PlanType;
  body: string;
}

/**
 * The readiness rules the operator IS sent to fix. `size L` is excluded on
 * purpose: the mapper derives size from the criterion count, so a nine-criterion
 * plan is a nine-criterion plan and printing "split it" under the block would
 * tell the operator to change a spec the gap gate just approved. The split is
 * the descriptor's problem, not the block's - and `readiness` still reports it
 * to every READER of the block. Both the render and the reservation read it
 * through this one function, so they cannot disagree about the section's cost.
 */
export function piSpecFailedRules(spec: PiSpec): string[] {
  const failed = readiness(spec).filter((r) => !r.startsWith("size L"));
  // A `command` criterion with no command is unverifiable, and it is the one
  // fault the MAPPER itself could introduce (a span read as a command that then
  // clipped away). `readiness` names it; a hand-edited issue can carry it too.
  for (const c of spec.criteria) {
    if (c.verify === "command" && (c.command === undefined || c.command.trim() === "")) {
      failed.push(`criterion ${c.id}: a command criterion must carry a non-empty command`);
    }
  }
  return failed;
}

function sliceSection(
  body: string,
  heading: string,
  skip = 0,
  before = body.length,
): string | undefined {
  // `exec` with a `g` flag honours `lastIndex`, so the scan starts at `skip`; the
  // `before` bound is what a `g` scan cannot express on its own — it would keep
  // walking and match a LATER occurrence of the same heading, which is exactly
  // how an appended disclosure would be read as the draft's own section.
  const re = SECTION_SLICE(heading);
  re.lastIndex = skip;
  const m = re.exec(body);
  return m !== null && m.index < before ? m[1] : undefined;
}

/** The offset where the acceptance-criteria section's heading begins (0 when absent). */
function criteriaStart(body: string): number {
  const re = /^## Acceptance criteria/gm;
  re.lastIndex = 0;
  return re.exec(body)?.index ?? 0;
}

/** The offset just past the acceptance-criteria section, where the next `## ` begins. */
function criteriaEnd(body: string): number {
  const start = criteriaStart(body);
  // +2, not +1: the `m` flag makes `^` match after ANY newline, so a search
  // started one byte into a heading line reports THAT heading's own line as the
  // next one. That made every section after the criteria fall outside the bound
  // and the block silently carried no scope at all.
  const re = /^## /gm;
  re.lastIndex = start + 2;
  return re.exec(body)?.index ?? body.length;
}

/**
 * Where the post-drafting disclosures begin, searched from `from`. The mapper
 * passes the offset just past the acceptance-criteria section, so an early
 * `## Base fallback` written INSIDE the draft cannot truncate the criteria away
 * - a top-of-body scan once did exactly that and silently filed no block.
 */
function draftedEnd(body: string, from: number): number {
  const re = new RegExp(`^## (${LATER_HEADING_SOURCE})`, "gm");
  re.lastIndex = from;
  const m = re.exec(body);
  return m === null ? body.length : m.index;
}

/** The bullets of one section, in order, with the status-only bullets dropped. */
function sectionBullets(body: string, skip: number, before: number, heading: string): string[] {
  const section = sliceSection(body, heading, skip, before);
  if (!section) return [];
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("_") && !l.startsWith("(") && !l.startsWith("..."));
}

/**
 * True when a backticked span IS a shell command: it starts with a bare runner
 * word (`bun test`, `./verify.sh`) rather than merely beginning with those
 * letters. `go test -run X` is a command; `the gov file` is not, and matching on
 * a prefix alone would call it one.
 */
function isRunnerCommand(cand: string): boolean {
  return RUNNER_WORDS.some((w) =>
    w === "./" ? cand.startsWith("./") : cand === w || cand.startsWith(`${w} `),
  );
}

/** The first backticked span in a criterion that states a runnable command. */
function commandIn(text: string): string | undefined {
  for (const m of text.matchAll(new RegExp(BACKTICK_SPAN.source, "g"))) {
    const cand = (m[1] ?? "").trim();
    if (isRunnerCommand(cand)) return cand;
  }
  return undefined;
}

/** S → at most 3 criteria, M → at most 8, L → more. */
function sizeOf(count: number): PiSpec["size"] {
  if (count <= SIZE_SMALL_MAX) return "S";
  if (count <= SIZE_MEDIUM_MAX) return "M";
  return "L";
}

/**
 * The drafted body → the contract. Criteria are the draft's own
 * `## Acceptance criteria` bullets, in order, with positional ids `AC1...`; one
 * that states a runnable command becomes a `command` criterion. Scope is what
 * the draft declares: the Test surface bullets as `paths` and the Out of scope
 * bullets as `out` (a Test surface still reporting "none", or an Out of scope
 * still carrying its "everything not named above" fallback, declares nothing and
 * is omitted). Returns undefined when there is nothing to contract: an epic, a
 * spike, or zero criteria.
 */
export function piSpecFromDraft(draft: PiSpecDraft): PiSpec | undefined {
  if (draft.type === "spike" || draft.type === "epic") return undefined;
  // The criteria are read from the top of the body - they are the earliest
  // section the mapper reads, and their end is what bounds every section after
  // them. So a post-drafting disclosure (residual gaps, open points, or a block
  // appended on an earlier pass) sits beyond `draftEnd` and can never be read as
  // the draft's criteria or fence.
  const criteria = sectionBullets(draft.body, 0, draft.body.length, "Acceptance criteria").map(
    (text, i) => {
      const command = commandIn(text);
      return command === undefined
        ? { id: `AC${i + 1}`, text, verify: "test" as const }
        : { id: `AC${i + 1}`, text, verify: "command" as const, command };
    },
  );
  if (criteria.length === 0) return undefined;

  // `draftEnd` is where a post-drafting disclosure begins AFTER the criteria, so
  // the scope sections are searched within `[criteriaEnd, draftEnd)`. `skip`
  // alone cannot express that: a `g`-flagged scan starting past a heading still
  // matches a LATER occurrence of the same heading, and draftSpec renders
  // `## Out of scope` last with no heading after it, so an unbounded scan would
  // have walked past the drafted fence and read an appended `## Out of scope`
  // disclosure as the issue's own. The `problem` keeps the same bound: the
  // context the draft wrote, never the disclosures added afterwards.
  const criteriaEndAt = criteriaEnd(draft.body);
  const draftEnd = Math.max(criteriaEndAt, draftedEnd(draft.body, criteriaEndAt));
  const paths = sectionBullets(draft.body, criteriaEndAt, draftEnd, "Test surface").filter(
    (s) => !/none/i.test(s),
  );
  const out = sectionBullets(draft.body, criteriaEndAt, draftEnd, "Out of scope").filter(
    (s) => !s.startsWith("everything not named"),
  );
  const scope =
    paths.length > 0 || out.length > 0
      ? { ...(paths.length > 0 ? { paths } : {}), ...(out.length > 0 ? { out } : {}) }
      : undefined;

  return {
    problem: draft.body.slice(0, draftEnd).trim().slice(0, PI_SPEC_PROBLEM_MAX_CHARS),
    criteria,
    ...(scope ? { scope } : {}),
    size: sizeOf(criteria.length),
  };
}

/** The heading, the fenced block, and (when not ready) the readiness line. */
export function renderPiSpecSection(spec: PiSpec): string {
  const rendered = renderPiSpec(spec);
  const failed = piSpecFailedRules(spec);
  const note = failed.length > 0 ? `\n\n${PI_SPEC_READINESS_PREFIX} ${failed.join("; ")}\n` : "\n";
  return `${PI_SPEC_HEADING}\n\n${rendered}\n${note}`;
}

/**
 * Append the `## Spec (pi-spec v1)` section to a drafted body. No-op (the body
 * byte-identical) when there is nothing to contract, or when the body already
 * carries a block - a corrective re-draft re-renders the body, and a second
 * block would make `parsePiSpec` refuse the issue.
 */
export function appendPiSpecSection(body: string, type: PlanType): string {
  if (parsePiSpec(body).ok) return body;
  const spec = piSpecFromDraft({ type, body });
  if (!spec) return body;
  return `${body.trimEnd()}\n\n${renderPiSpecSection(spec)}`;
}

/**
 * The width the budget fitter holds back so the appended section can never push
 * the filed body over the forge cap: the rendered section plus the blank line
 * that separates it. The fitter adds this to the provenance reservation, so both
 * after-the-fitter appends are paid for up front and neither can be trimmed.
 */
export function piSpecReservation(type: PlanType, body: string): number {
  const spec = piSpecFromDraft({ type, body });
  if (!spec || parsePiSpec(body).ok) return 0;
  return renderPiSpecSection(spec).length + 2;
}
