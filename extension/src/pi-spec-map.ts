/**
 * pi-spec-map — the one mapping from a list of plain-language bullets to a
 * `pi-spec v1` contract.
 *
 * Two producers need the same mapping and must not keep two copies: `/plan`
 * maps the criteria bullets of a drafted body
 * (`piSpecFromDraft` in `plan-pi-spec.ts`), and `work-lean`'s spec-intake mode
 * maps the bullets a deriving child returned (`lean/spec-derive.ts`). Two
 * mappers drift — one clips at 199, the other neutralises after the clip — and
 * the two producers then file contracts that read differently for the same
 * words, which is exactly the thing `lean/spec.ts`'s shared fence predicate
 * exists to prevent.
 *
 * This module is a LEAF: `./lean/spec.ts` is its only import, so `lean/` can
 * reach the mapping without reaching `/plan` (`plan-draft.ts`, its model calls,
 * its forge and vipune reads) through it.
 *
 * The bounds are the ones `/plan` has always applied, and they are stated here
 * because this is where they are enforced: the problem line is clipped to
 * {@link PROBLEM_MAX_CHARS}, each criterion's text to
 * {@link CRITERION_MAX_CHARS}, at most {@link MAX_CRITERIA} criteria ride in the
 * block — but `size` counts the ORIGINAL set, so a twenty-bullet list is
 * honestly `L` even though twelve came through. Every criterion is
 * `verify: "test"` with no command: neither producer may make a criterion
 * executable, which is the whole reason a hand-written block is the only place
 * a `command` criterion can come from.
 *
 * Neutralise BEFORE clipping, never after: the look-alikes are 1:1 in width and
 * BMP, so a clipped field cannot end mid-stand-in, and a bullet whose fences
 * collapsed cannot lose its tail to the clip.
 */
import type { PiSpec } from "./lean/spec.ts";

/** The problem line never renders longer than this. */
export const PROBLEM_MAX_CHARS = 200;

/** The most criteria a block carries; the size band still counts the original. */
export const MAX_CRITERIA = 12;

/** One criterion's text never renders longer than this. */
export const CRITERION_MAX_CHARS = 200;

/** The size bands the contract's `size` field reports. */
const SIZE_SMALL_MAX = 3;
const SIZE_MEDIUM_MAX = 8;

/**
 * Every run of three or more backticks or tildes in `s` replaced by look-alikes,
 * so the text can sit inside the block's JSON without ever opening or closing a
 * fence. The block is fenced with three backticks, and a JSON-escaped backtick
 * still renders as a backtick on the line that carries it — so a criterion that
 * quotes a fenced snippet would terminate the block early and make the whole
 * spec unparseable.
 *
 * A single backtick is left alone: it cannot fence anything, and it is the common
 * case (`run \`bun test\`` inside a criterion). Each character of a run becomes
 * ONE look-alike code point — U+02CB for a backtick, U+02DC for a tilde — so a
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
    out += j - i >= 3 ? (c === "`" ? "ˋ" : "˜").repeat(j - i) : c.repeat(j - i);
    i = j;
  }
  return out;
}

/**
 * Clip to `max` UTF-16 code UNITS, never splitting a surrogate pair.
 *
 * The ceiling every caller enforces is measured in `.length` — the same units
 * `parsePiSpec`, the forge cap and the budget reservation are counted in — so a
 * code-point clip would let astral text (emoji, CJK extension B) over-run the
 * very bound it is supposed to keep. A trailing high surrogate is dropped rather
 * than left dangling.
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(max - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, max - 1);
  return out;
}

/**
 * One printable line: control characters become spaces, a lone surrogate becomes
 * U+FFFD, and whitespace runs collapse. Iterated by code point, so a valid surrogate
 * pair (an emoji) arrives whole; only an unpaired surrogate is in the surrogate range.
 */
export function oneLine(s: string): string {
  const printable = Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) return "�";
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return " ";
    return ch;
  });
  return printable.join("").replace(/\s+/g, " ").trim();
}

/** S → at most 3 criteria, M → at most 8, L → more. Counts the ORIGINAL set. */
export function sizeOf(count: number): PiSpec["size"] {
  if (count <= SIZE_SMALL_MAX) return "S";
  if (count <= SIZE_MEDIUM_MAX) return "M";
  return "L";
}

/** One bullet as the block carries it: one line, fences disarmed, clipped. */
export function criterionText(bullet: string): string {
  return clip(neutraliseFenceRuns(oneLine(bullet)), CRITERION_MAX_CHARS);
}

/** The problem field as the block carries it, from whatever statement was chosen. */
export function problemText(problem: string): string {
  return clip(neutraliseFenceRuns(oneLine(problem)), PROBLEM_MAX_CHARS);
}

/** Whether a block is one {@link piSpecFromBullets} could have produced, or the
 * disagreement to report. Its own function because the two callers read different
 * fields — `criteria`/`size` (a caller validating a spec, not a block) and `verify`/
 * `scope` (the load gate for a spec a model could never have made executable) — and
 * must not answer them twice. Only `size` is checked against the count, never the
 * count itself: this leaf bounds what a mapping embeds, it does not decide when a
 * change is too big for one run — `readiness`'s size-`L` rule owns that. A derived
 * contract's regression guards count toward the band (`guards`), so splitting one off
 * never moves it. */
export function mappingDisagrees(
  spec: Pick<PiSpec, "criteria" | "size">,
  guards = 0,
): string | undefined {
  const n = spec.criteria.length;
  if (n > MAX_CRITERIA)
    return `carries ${String(n)} criteria where a mapping embeds ${String(MAX_CRITERIA)}`;
  const counted =
    guards === 0 ? `${String(n)} criteria` : `${String(n)} criteria and ${String(guards)} guards`;
  if (spec.size !== sizeOf(n + guards))
    return `is stamped ${spec.size} for ${counted} where the mapping says ${sizeOf(n + guards)}`;
  return undefined;
}

/**
 * The bullets → the contract, bounded by construction: positional ids `AC1…`,
 * every criterion `verify: "test"` with no command, at most
 * {@link MAX_CRITERIA} embedded, `size` from the original count, no `scope`.
 *
 * Returns `undefined` when there is nothing to contract: no bullets at all, or
 * no statement to make (`parsePiSpec` refuses an empty `problem`, so one must
 * never be filed).
 */
export function piSpecFromBullets(problem: string, bullets: readonly string[]): PiSpec | undefined {
  const statement = problemText(problem);
  if (statement === "") return undefined;
  if (bullets.length === 0) return undefined;
  const criteria = bullets.slice(0, MAX_CRITERIA).map((bullet, i) => ({
    id: `AC${String(i + 1)}`,
    text: criterionText(bullet),
    verify: "test" as const,
  }));
  return { problem: statement, criteria, size: sizeOf(bullets.length) };
}
