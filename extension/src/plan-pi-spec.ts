/**
 * plan-pi-spec - the drafted /plan spec mapped onto the `pi-spec v1` contract
 * (epic #1883), so every issue the driver files carries the machine-readable
 * block the lean /work engine reads (`extension/src/lean/spec.ts`).
 *
 * BOUNDED BY CONSTRUCTION, PLACED AT THE TOP, READ BACK BEFORE FILING:
 *
 *   - `piSpecFromDraft` bounds every field it emits — `problem` is the issued
 *     TITLE clipped to 200 UTF-16 units (never body prose), at most 12 criteria
 *     at 200 units each, no `scope` at all.
 *   - `placePiSpecSection` puts `## Spec (pi-spec v1)` at the TOP of the body
 *     (under the provenance italic line when the caller has one), above every
 *     drafted and disclosed section. Then it READS THE BLOCK BACK through the
 *     real parser and requires it to deep-equal the spec it embedded.
 *   - `piSpecReservation` is a CONSTANT per plan type, not a measurement: it can
 *     never under-count, and it needs no second render of the draft.
 *   - the drafted prose NEVER contributes a block: every `pi-spec v1` fence that
 *     was already in the body has its info string renamed to `pi-spec-example v1`
 *     before ours is placed, so a quoted example in an angle item can never become
 *     the contract.
 *   - every omission is TRACED, and the rendered section is MEASURED against
 *     `PI_SPEC_SECTION_MAX_CHARS` — a ceiling a reader has to take on faith is not
 *     a ceiling.
 *
 * Why the TOP, where the first draft appended at the END: the drafted body is
 * agent prose, and one unclosed code fence in it changes what `fencedBlocks`
 * sees. A fence opened ABOVE an appended block swallows it. Placing the block
 * first means no prose written below it can reach it, and the read-back catches
 * what remains.
 *
 * Why `problem` is the TITLE and there is no `scope`: a body-derived problem
 * carried drafted prose into a machine field, including failure text the plan
 * never promised; and the drafted Test surface / Out of scope bullets are prose
 * that `plan-draft.ts` clips at 400 chars, which is not a fence anyone verified.
 *
 * An epic and a spike get no block: an epic's criteria belong to its sub-issues,
 * and a spike's criteria slot is the Expected deliverable — a decision or a proof
 * of concept. Promoting one into a verifiable criterion would be a claim the
 * draft never made.
 */
import type { PiSpec } from "./lean/spec.ts";
import { SPEC_INFO, parsePiSpec, readiness, renderPiSpec } from "./lean/spec.ts";
import { fencePrefix, opensFenceWith } from "./plan-pi-spec-fences.ts";
import type { PlanType } from "./plan-types.ts";
import { trace } from "./trace.ts";

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

/**
 * What the info string of a DRAFTED `pi-spec v1` fence is renamed to: `SPEC_INFO`
 * plus `-example`. A body that QUOTES the contract (an angle item showing what a
 * block looks like) can therefore never be read as one — `parsePiSpec` matches the
 * info string exactly, so the example stays prose and our block is the only
 * contract in the file.
 */
export const PI_SPEC_EXAMPLE_INFO = `${SPEC_INFO}-example`;

/** The problem field is the issue TITLE, and never renders longer than this. */
export const PI_SPEC_PROBLEM_MAX_CHARS = 200;

/** The most criteria the block embeds; the size band still counts the original. */
export const PI_SPEC_MAX_CRITERIA = 12;

/** One criterion's text, and one criterion's command, never render longer. */
export const PI_SPEC_CRITERION_MAX_CHARS = 200;

/**
 * The ceiling the rendered section stays under — and so the most the reservation
 * can ever cost the fitter. DERIVED from the bounds above, not hand-tuned.
 *
 * The per-field allowance is FOUR times the field bound, not two, and that factor
 * is the whole of the astral story: `renderPiSpec` emits `JSON.stringify` at
 * indent 2, which escapes one astral character (a surrogate pair) as
 * `\uD83D\uDE80` — sixteen UTF-16 units for what `.slice` clipped to one. A bound
 * of 2× a field therefore measured a render that astral text (emoji, CJK
 * extension B) over-ran by half. 4× is the exact worst case — both fields astral,
 * both fully escaped — plus the id, keys, quotes and indentation
 * (`CRITERION_JSON_OVERHEAD`), and the heading, fence lines, problem line and
 * readiness note are the leading 160.
 *
 * The sibling smoke tests render BOTH worst cases (ASCII and astral) and assert
 * each sits under this number, so widening a bound fails a test instead of quietly
 * widening the reservation — and `placePiSpecSection` still MEASURES the render
 * and refuses it when it is over, so a mis-derived ceiling cannot file an
 * over-budget body.
 */
const CRITERION_JSON_OVERHEAD = 16;
const JSON_ESCAPE_FACTOR = 4;
export const PI_SPEC_SECTION_MAX_CHARS =
  160 +
  JSON_ESCAPE_FACTOR * PI_SPEC_PROBLEM_MAX_CHARS +
  PI_SPEC_MAX_CRITERIA *
    (JSON_ESCAPE_FACTOR * PI_SPEC_CRITERION_MAX_CHARS + CRITERION_JSON_OVERHEAD);

/** The most failed rules the readiness note prints, and how long one may be. */
const READINESS_NOTE_MAX_RULES = 3;
const READINESS_RULE_MAX_CHARS = 120;

/** The width of the omission line: its prefix, a reason clipped to 200, and the join. */
export const PI_SPEC_OMISSION_LINE_MAX_CHARS = PI_SPEC_OMISSION_PREFIX.length + 1 + 200 + 2;

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
 * The readiness rules the operator IS sent to fix: `readiness` is the ONLY
 * statement of them, with no local duplicate and no filter — `size L` stays in the
 * note so the operator actually sees "split it" rather than a block that quietly
 * promises a thirteen-criterion run.
 */
export function piSpecFailedRules(spec: PiSpec): string[] {
  return readiness(spec);
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

/**
 * Clip to `max` UTF-16 code UNITS, never splitting a surrogate pair.
 *
 * The ceiling every caller enforces is measured in `.length` — the same units
 * `parsePiSpec`, the forge cap and the budget reservation are counted in — so a
 * code-point clip would let astral text (emoji, CJK extension B) over-run the very
 * bound it is supposed to keep. A trailing high surrogate is dropped rather than
 * left dangling.
 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(max - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, max - 1);
  return out;
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
    // Neutralise FIRST, then clip: the 1:1 look-alikes keep the width honest (they
    // are BMP code points, so a neutralised field never carries a surrogate pair),
    // and a bullet whose fences collapse cannot lose its tail to the clip.
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
  // The note is BOUNDED too: an unbounded `join("; ")` over every failed rule made
  // the section's width a function of how broken the spec is, which is the one
  // input a ceiling must not have.
  const failed = piSpecFailedRules(spec)
    .slice(0, READINESS_NOTE_MAX_RULES)
    .map((r) => clip(oneLine(r), READINESS_RULE_MAX_CHARS));
  const note = failed.length > 0 ? `\n\n${PI_SPEC_READINESS_PREFIX} ${failed.join("; ")}\n` : "\n";
  return `${PI_SPEC_HEADING}\n\n${rendered}\n${note}`;
}

/**
 * Rename EVERY drafted `pi-spec v1` fence to `pi-spec-example v1`.
 *
 * Without this the drafted prose can supply the contract: an angle item that
 * QUOTES the block format puts a real `pi-spec v1` fence in the body, and the
 * example — written to illustrate, not to promise — becomes what the executor runs
 * against. So the info string of every such fence is renamed BEFORE ours is
 * placed, unconditionally, and our block is always the only one.
 *
 * A plain line-by-line loop, with the fence grammar itself in
 * `plan-pi-spec-fences.ts`: the line is only an opening fence when no fence is
 * already open above it, so a `pi-spec v1` that appears as another fence's
 * CONTENT is left alone, and a closing fence (which carries no info string) is
 * never rewritten.
 */
export function neutraliseDraftedPiSpecFences(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      opensFenceWith(line, SPEC_INFO) ? `${fencePrefix(line)}${PI_SPEC_EXAMPLE_INFO}` : line,
    )
    .join("\n");
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
  /** True when this placement wrote the block. */
  placed?: boolean;
  /** Why there is no block: nothing to contract, over the ceiling, or a failed read-back. */
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
 * The drafted body's own `pi-spec v1` fences are renamed before placement, so the
 * block this writes is the ONLY one, and a body that already carried a block — a
 * corrective re-draft, a hand-edited issue, an angle item that quotes the format —
 * can never supply the contract. Every omission is TRACED: a filed body with no
 * block is otherwise indistinguishable from one that never needed one.
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
  if (!spec) return omit(body, type, title, reasonWithoutSpec(type, title));
  const section = renderPiSpecSection(spec);
  // The ceiling is asserted on the RENDER, not inferred from the mapper's bounds:
  // `PI_SPEC_SECTION_MAX_CHARS` must hold for ANY input, and the only honest way
  // to promise that is to measure what was actually produced and refuse it when it
  // is over.
  if (section.length > PI_SPEC_SECTION_MAX_CHARS) {
    return omit(body, type, title, "pi-spec block over its size ceiling");
  }
  const candidate = placeSection(neutraliseDraftedPiSpecFences(body), section, provenanceLine);
  const back = parsePiSpec(candidate);
  if (!back.ok) {
    return omit(body, type, title, back.reason, true);
  }
  if (JSON.stringify(back.spec) !== JSON.stringify(spec)) {
    return omit(body, type, title, "the block read back different from the one embedded", true);
  }
  return { body: candidate, spec, placed: true, omitted: undefined };
}

/** Every omission goes through here, so none of them is silent. */
function omit(
  body: string,
  type: PlanType,
  title: string,
  reason: string,
  disclosure = false,
): PiSpecPlacement {
  trace(`plan-pi-spec: block omitted — reason=${reason} type=${type} titleLength=${title.length}`);
  return {
    // The disclosure is appended to `body`, not to a candidate, so nothing of the
    // candidate's rewritten shape leaks into a filing that has no block in it.
    body: disclosure ? `${body.trimEnd()}\n\n${PI_SPEC_OMISSION_PREFIX} ${reason}\n` : body,
    spec: undefined,
    omitted: reason,
  };
}

/** Why there is no block when the mapper produced no spec. */
function reasonWithoutSpec(type: PlanType, title: string): string {
  if (type === "epic" || type === "spike") return `a ${type} has no runnable acceptance criteria`;
  if (typeof title !== "string" || title.trim() === "")
    return "no issue title to state the problem";
  return "the drafted body has no acceptance criteria";
}

/**
 * The width the budget fitter holds back so the section placed at the top can
 * never push the filed body over the forge cap.
 *
 * It is a CONSTANT, not a measurement: the ceiling every field is bounded by is
 * known (`PI_SPEC_SECTION_MAX_CHARS`) and the second term bounds the disclosure
 * line an omitted filing carries (its prefix + a reason clipped to 200). The
 * earlier version RENDERED the block to measure it, which cost a third `draftSpec`
 * call per run and — because it rendered the stage-0 probe — corrupted the
 * dropped-render holder (#1383). A constant cannot under-count, cannot be measured
 * on the wrong render, and costs nothing.
 *
 * A plan with zero criteria over-reserves: it gets no block and pays for a block it
 * never filed. That is the honest direction — the alternative is a reservation that
 * under-counts, and an under-count is what lets a post-fit append blow the forge cap.
 */
export function piSpecReservation(type: PlanType): number {
  if (type === "epic" || type === "spike") return 0;
  return PI_SPEC_SECTION_MAX_CHARS + 2 + PI_SPEC_OMISSION_LINE_MAX_CHARS;
}
