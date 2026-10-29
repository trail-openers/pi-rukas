/**
 * plan-pi-spec - the drafted /plan spec mapped onto the `pi-spec v1` contract
 * (epic #1883), so every issue the driver files carries the machine-readable
 * block the lean /work engine reads (`extension/src/lean/spec.ts`).
 *
 * BOUNDED BY CONSTRUCTION, PLACED AT THE TOP, READ BACK BEFORE FILING:
 *
 *   - `piSpecFromDraft` bounds every field it emits — `problem` is the issued
 *     TITLE clipped to 200 chars (never body prose), at most 12 criteria at 200
 *     chars each, no `scope` at all. The rendered section therefore has a hard
 *     ceiling (`PI_SPEC_SECTION_MAX_CHARS`), which is why the budget reservation
 *     needs no clamp.
 *   - `placePiSpecSection` puts `## Spec (pi-spec v1)` at the TOP of the body
 *     (under the provenance italic line when the caller has one), above every
 *     drafted and disclosed section. Then it READS THE BLOCK BACK through the
 *     real parser and requires it to deep-equal the spec it embedded.
 *   - `piSpecReservation` returns that section's REAL rendered length, so the
 *     fitter's headroom pays for the block exactly.
 *
 * Why the TOP, where the first draft appended at the END: the drafted body is
 * agent prose, and one unclosed code fence in it changes what `fencedBlocks`
 * sees. A fence opened ABOVE an appended block swallows it — the spec block never
 * closes, `parsePiSpec` says "no block", and the issue files looking contracted
 * while carrying nothing the executor can read. Placing the block first means no
 * prose written below it can reach it, and the read-back catches what remains.
 *
 * Why `problem` is the TITLE and there is no `scope`: a body-derived problem
 * carried drafted prose into a machine field, including failure text the plan
 * never promised; and the drafted Test surface / Out of scope bullets are prose
 * that `plan-draft.ts` clips at 400 chars, which is not a fence anyone verified.
 * The block carries only what is machine-checkable: criteria.
 *
 * An epic and a spike get no block: an epic's criteria belong to its sub-issues,
 * and a spike's criteria slot is the Expected deliverable — a decision or a proof
 * of concept. Promoting one into a verifiable criterion would be a claim the
 * draft never made.
 */
import type { PiSpec } from "./lean/spec.ts";
import { parsePiSpec, readiness, renderPiSpec } from "./lean/spec.ts";
import type { PlanType } from "./plan-types.ts";

/** The section heading the block renders under. */
export const PI_SPEC_HEADING = "## Spec (pi-spec v1)";

/** Prefix of the operator-visible readiness line. */
export const PI_SPEC_READINESS_PREFIX = "pi-spec readiness:";

/**
 * Prefix of the disclosure line a body files with when its block was left out.
 * Plain text at the END of the body, never a heading: the block's absence is a
 * fact the operator reads, not a section they skim past.
 */
export const PI_SPEC_OMISSION_PREFIX = "pi-spec block omitted:";

/** The problem field is the issue TITLE, and never renders longer than this. */
export const PI_SPEC_PROBLEM_MAX_CHARS = 200;

/** The most criteria the block embeds; the size band still counts the original. */
export const PI_SPEC_MAX_CRITERIA = 12;

/** One criterion's text, and one criterion's command, never render longer. */
export const PI_SPEC_CRITERION_MAX_CHARS = 200;

/**
 * The ceiling the rendered section stays under — and so the most the reservation
 * can ever cost the fitter. DERIVED from the bounds above, not hand-tuned: JSON
 * at indent 2 gives each criterion its two 200-code-point fields plus the id,
 * keys and indentation around them (`CRITERION_JSON_OVERHEAD`, measured on the
 * worst-case render), and the heading, fence lines and problem line are the rest.
 * `test-plan-pi-spec.ts` asserts the ACTUAL worst-case render (12 × 200-char
 * criteria with 200-char commands, a 200-char title) sits under it, so widening a
 * bound fails a test instead of quietly widening the reservation.
 */
const CRITERION_JSON_OVERHEAD = 16;
export const PI_SPEC_SECTION_MAX_CHARS =
  160 +
  PI_SPEC_PROBLEM_MAX_CHARS +
  PI_SPEC_MAX_CRITERIA * (2 * PI_SPEC_CRITERION_MAX_CHARS + CRITERION_JSON_OVERHEAD);

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

/** The fallback bullet draftSpec renders when no criterion exists; not a criterion. */
const AC_FALLBACK_BULLET = "(fallback";

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

/** The fields the mapper reads - all of them sections the draft really renders. */
export interface PiSpecDraft {
  type: PlanType;
  /** The drafted body, which carries `## Acceptance criteria`. */
  body: string;
  /** The filed title (`Phase3Fitted.title`); becomes the clipped `problem`. */
  title: string;
}

/**
 * The readiness rules the operator IS sent to fix. `size L` is excluded on
 * purpose: the mapper derives size from the criterion count, so a thirteen-
 * criterion plan is a thirteen-criterion plan and printing "split it" under the
 * block would tell the operator to change a spec the gap gate just approved. The
 * split is the descriptor's problem, not the block's - and `readiness` still
 * reports it to every READER of the block. Both the render and the reservation
 * read it through this one function, so they cannot disagree about the cost.
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

/**
 * Every run of three or more backticks or tildes in `s` replaced by look-alikes,
 * so the text can sit inside the block's JSON without ever opening or closing a
 * fence. The block is fenced with three backticks, and a JSON-escaped backtick
 * still renders as a backtick on the line that carries it - so a criterion that
 * quotes a fenced snippet would terminate the block early and make the whole spec
 * unparseable.
 *
 * A single backtick is left alone: it cannot fence anything, and it is the common
 * case (`run \`bun test\`` inside a criterion). Each character of a run becomes
 * ONE look-alike code point - U+02CB for a backtick, U+02DC for a tilde - so a
 * reader sees a quote mark where the fence was, and the 1:1 width is what lets
 * the mapper clip AFTER neutralising without cutting a stand-in in half. Written
 * as a code-point loop rather than a regex class because the run length must be
 * counted, not merely matched.
 */
export function neutraliseFenceRuns(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c !== "`" && c !== "~") {
      out += c;
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === c) j++;
    out += j - i >= 3 ? (c === "`" ? "\u02cb" : "\u02dc").repeat(j - i) : c.repeat(j - i);
    i = j;
  }
  return out;
}

/** Clip to `max` CODE POINTS (a UTF-16 slice can split a surrogate pair). */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/** Collapse every run of whitespace to one space, so a field stays one line's worth. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The bullets of one `## <heading>` section, in order, status-only bullets dropped. */
function sectionBullets(body: string, heading: string): string[] {
  const m = SECTION_SLICE(heading).exec(body);
  if (!m?.[1]) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(
      (l) =>
        l !== "" && !l.startsWith("_") && !l.startsWith(AC_FALLBACK_BULLET) && !l.startsWith("..."),
    );
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
 * The drafted body + title → the contract, bounded by construction. Criteria are
 * the draft's own `## Acceptance criteria` bullets, in order, with positional ids
 * `AC1...`; one that states a runnable command becomes a `command` criterion (the
 * command is the rule, and the criterion's text stays beside it). At most
 * `PI_SPEC_MAX_CRITERIA` are embedded, but `size` counts the ORIGINAL set - a
 * thirteen-criterion plan is honestly `L` even though twelve ride in the block.
 * `problem` is the title; there is no `scope`.
 *
 * `command` is read from the RAW bullet and `text` from the clipped one, so a
 * criterion whose command sits past the 200-char clip keeps its command rather
 * than filing an unverifiable `command` criterion with none.
 *
 * Returns undefined when there is nothing to contract: an epic, a spike, zero
 * criteria, or a title so empty there is no `problem` to state (a spec with an
 * empty problem is one `parsePiSpec` refuses, so it must not be filed).
 */
export function piSpecFromDraft(draft: PiSpecDraft): PiSpec | undefined {
  if (draft.type === "spike" || draft.type === "epic") return undefined;
  const title = typeof draft.title === "string" ? draft.title : "";
  if (title.trim() === "") return undefined;
  const all = sectionBullets(draft.body, "Acceptance criteria");
  if (all.length === 0) return undefined;
  const criteria = all.slice(0, PI_SPEC_MAX_CRITERIA).map((raw, i) => {
    // Neutralise FIRST, then clip: the 1:1 look-alikes keep the width honest, and
    // a bullet whose fences collapse cannot lose its tail to the clip.
    const text = clip(neutraliseFenceRuns(oneLine(raw)), PI_SPEC_CRITERION_MAX_CHARS);
    const command = commandIn(raw);
    return command === undefined
      ? { id: `AC${i + 1}`, text, verify: "test" as const }
      : {
          id: `AC${i + 1}`,
          text,
          verify: "command" as const,
          command: clip(neutraliseFenceRuns(oneLine(command)), PI_SPEC_CRITERION_MAX_CHARS),
        };
  });

  return {
    problem: clip(neutraliseFenceRuns(oneLine(title)), PI_SPEC_PROBLEM_MAX_CHARS),
    criteria,
    size: sizeOf(all.length),
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
 * The body with the section inserted at the TOP: after the provenance italic
 * first line when the caller supplied one, otherwise first. The drafted prose
 * follows it untouched, so a fence the prose opens below can never swallow the
 * block above it.
 */
function placeSection(body: string, section: string, provenanceLine: string | undefined): string {
  if (body.trim() === "") {
    return provenanceLine ? `${provenanceLine}\n\n${section}` : section;
  }
  const tail = body.trimStart();
  const head = provenanceLine ? `${provenanceLine}\n\n${section}` : section;
  // Exactly one blank line between the block and the prose beneath it, whatever
  // the draft ended with: the section already carries its own trailing newline.
  return `${head}\n${tail}`.replace(/\n{3,}(?=\S)/g, "\n\n");
}

/** What the placement did: where the section went, and whether to trust it. */
export interface PiSpecPlacement {
  /** The section placed at the top; byte-identical to `body` when there is none. */
  body: string;
  /** The spec that was embedded (undefined when no block was written). */
  spec: PiSpec | undefined;
  /** Why there is no NEW block: nothing to contract, an existing block, or a failed read-back. */
  omitted: string | undefined;
}

/**
 * Put the block at the top of a body and READ IT BACK.
 *
 * The read-back is the gate, not a formality: `parsePiSpec` on the FINAL body
 * must be ok and must return a spec deep-equal to the one embedded. It is the
 * same reader the lean engine uses (`lean/command.ts`), so a body that fails here
 * is one whose issue the executor would reject - and the failure is invisible
 * otherwise, because the block still looks present to a human. A body that fails
 * files WITHOUT our section and carries one plain line naming the reason.
 *
 * No-ops (body byte-identical) when there is nothing to contract, or when the
 * body already carries a block: a corrective re-draft re-renders the body, and a
 * second block makes `parsePiSpec` refuse the whole issue - so the second pass
 * keeps the contract the body has and adds nothing.
 *
 * `provenanceLine` is the caller's RENDERED italic provenance line. It is passed
 * in because the caller may wrap this body with `withProvenance` afterwards, which
 * prepends that line unconditionally: without knowing it, this function's
 * `trimStart` would eat the copy the wrapper prepends and the line would land
 * twice. Knowing it, the placer emits the line once and the wrapper leaves it.
 */
export function placePiSpecSection(
  body: string,
  type: PlanType,
  title: string,
  provenanceLine?: string,
): PiSpecPlacement {
  const spec = piSpecFromDraft({ type, body, title });
  if (!spec) {
    return { body, spec: undefined, omitted: reasonWithoutSpec(type, title) };
  }
  if (parsePiSpec(body).ok) {
    // Already contracted: the body's own block IS the contract, so it stays and
    // nothing is added. `spec` is still reported, so the caller can tell this
    // apart from "nothing to contract" and stay silent about it.
    return { body, spec, omitted: "the body already carries a pi-spec v1 block" };
  }
  const candidate = placeSection(body, renderPiSpecSection(spec), provenanceLine);
  const back = parsePiSpec(candidate);
  if (!back.ok) {
    return omitReadBack(body, back.reason);
  }
  if (JSON.stringify(back.spec) !== JSON.stringify(spec)) {
    return omitReadBack(body, "the block read back different from the one embedded");
  }
  return { body: candidate, spec, omitted: undefined };
}

/** Why there is no block when the mapper produced no spec. */
function reasonWithoutSpec(type: PlanType, title: string): string {
  if (type === "epic" || type === "spike") return `a ${type} has no runnable acceptance criteria`;
  if (typeof title !== "string" || title.trim() === "")
    return "no issue title to state the problem";
  return "the drafted body has no acceptance criteria";
}

/** A body that failed its own read-back: its own text, plus the disclosure line. */
function omitReadBack(body: string, reason: string): PiSpecPlacement {
  return {
    // The disclosure is appended to `body`, not to the candidate, so nothing of the
    // candidate's rewritten shape leaks into a filing that has no block in it.
    body: `${body.trimEnd()}\n\n${PI_SPEC_OMISSION_PREFIX} ${reason}\n`,
    spec: undefined,
    omitted: reason,
  };
}

/**
 * Append the `## Spec (pi-spec v1)` section to a body that carries no provenance
 * line (the shape the smoke tests drive directly). See `placePiSpecSection`.
 */
export function appendPiSpecSection(body: string, type: PlanType, title: string): string {
  const placed = placePiSpecSection(body, type, title);
  // A title present but EMPTY is a real failure to contract (a spec with an empty
  // `problem` would not parse), and this helper has no wrapper to disclose it, so
  // the line is added here. An ABSENT-but-typed title is the caller's problem.
  if (placed.spec === undefined && placed.omitted !== undefined && title.trim() === "") {
    return `${body.trimEnd()}\n\n${PI_SPEC_OMISSION_PREFIX} ${placed.omitted}\n`;
  }
  return placed.body;
}

/**
 * The width the budget fitter holds back so the section placed at the top can
 * never push the filed body over the forge cap: the rendered section plus the
 * blank line that separates it. The fitter adds this to the provenance
 * reservation, so both after-the-fitter appends are paid for up front.
 *
 * There is deliberately NO clamp, and the reason is `piSpecFromDraft`: every
 * field is bounded there, so the section's real rendered length IS the reservation
 * and it has a hard ceiling two orders of magnitude below the body budget
 * (`PI_SPEC_SECTION_MAX_CHARS`). A clamped reservation would UNDER-count, and an
 * under-count is what lets a post-fit append blow the forge cap.
 */
export function piSpecReservation(type: PlanType, body: string, title: string): number {
  const spec = piSpecFromDraft({ type, body, title });
  if (!spec || parsePiSpec(body).ok) return 0;
  return renderPiSpecSection(spec).length + 2;
}
