/**
 * work-driver-verify-tally — #1762: the CONSOLIDATED-only harvest of a script's
 * own tally block, where the names live one per line *beneath* the count.
 *
 * The defect. A project gate that reports
 *
 *     test.sh: failed checks (2), not run (0)
 *         lint
 *         test/b_test.sh
 *
 * puts the names on their own lines under the count, not inside it. The per-file
 * `FAILED:` marker carries the assertion; this block carries only the count and
 * two bare words. `assertionLines` had nothing to offer for it, so a consolidated
 * failure of that shape earned no corrective round and the developer was dispatched
 * with the tally alone.
 *
 * Why this is CONSOLIDATED-ONLY, and stays that way. The single reason is the
 * CALLER: {@link harvestConsolidatedTallies} has exactly one production reader,
 * `consolidatedAssertionLines` in `work-driver-verify-record.ts` — the route that
 * holds the consolidated run's RAW gate stream. The per-worktree route goes
 * through `assertionLines`, and `formatExecError` does NOT guarantee a one-line
 * record: when the tail fits its window the wrapper KEEPS the tail's newlines and
 * indentation (pinned by the tally-last case of the shape suite), so the
 * indentation this harvest reads can and does survive into a per-worktree record.
 * Harvesting there read a tally block out of harness prose and emitted a SECOND
 * evidence line opening with the harness's own sentence, costing a
 * `CORRECTIVE_MAX_LINES` slot for text the gate never printed. So the route is
 * decided by the reader that knows which route it is on, not by a property of the
 * wrapper, and the harness cut in `work-driver-verify-inner-line.ts`
 * (`harnessInnerLine`, `harnessVerifyStream`, `stripHarnessResidue`) is deliberately
 * UNCHANGED — it is the reader that decides what a human is SHOWN, and the harvest
 * is a reader of the gate's raw text.
 *
 * Cost, and the two bounds that hold it. A tally's `N` is text from the gate, so
 * the harvest may not cost what it reports: a `failed checks (999999)` line with
 * a million indented tokens used to walk all of them and build a million-name
 * join. So (a) a candidate name line longer than {@link TALLY_NAME_LINE_MAX}
 * stops the harvest — no runner prints a test name as a document, and the line
 * the classifier is asked on is bounded before it is asked; and (b) at most
 * {@link TALLY_NAMES_MAX} names are kept per tally, independent of the printed
 * count, with the cut reported as ` (+K more)`.
 *
 * Two rules the harvest obeys, both from #1762's misquote of a passing stage:
 *
 *   - **Indentation is measured BEFORE trimming.** "Deeper than the tally" is a
 *     fact about the raw line; a reader that trims first cannot see it and would
 *     harvest the whole stream.
 *   - **The harvest stops at the first failure.** A name line that classifies as a
 *     failure, or reports success, is not a name — so a stream that continues into
 *     its timing block (`  pack_release_test.sh   21.4s`) or into an `ok` line
 *     contributes nothing beyond the point where it stopped being a list.
 *   - **The joined names never exceed {@link TALLY_JOIN_MAX},** which is half the
 *     record's {@link ASSERTION_LINE_MAX} so the tally prefix and the disclosure fit
 *     inside it whatever the gate printed as the count.
 */

import { redactSecrets } from "./secret-patterns.ts";
import { looksLikeCredential } from "./work-driver-verify-assertion.ts";
import {
  classifyFailureLine,
  isSuccessLine,
  scriptTallyCount,
} from "./work-driver-verify-failures.ts";
import { ASSERTION_LINE_MAX } from "./work-driver-verify-record.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/** A name line's own shape: a bare token, nothing a runner prints a status with. */
const NAME_LINE_RE = /^[A-Za-z0-9_./-]+$/;

/**
 * The longest candidate line the harvest will even LOOK at. `NAME_LINE_RE` is
 * linear, but the classifier asks several patterns with `[^\r\n]*`-style
 * branches, and a name line is text from the gate: a 100 KB token must stop the
 * walk, not be classified. A real test name is a path or an identifier — nothing
 * a runner prints is anywhere near this long.
 */
const TALLY_NAME_LINE_MAX = 128;

/**
 * The most names one tally contributes, whatever its printed count says. The
 * joined line is evidence in a corrective-round prompt, not a report; past this
 * the extra names add cost and no diagnosis. The remainder is reported as
 * ` (+K more)` so the evidence does not silently understate the tally.
 */
const TALLY_NAMES_MAX = 20;

/** The most one joined tally line may carry — the WHOLE line, tally included. */
const TALLY_LINE_MAX = 200;

/**
 * A separator-free run of 32 or more characters that reads as a DIGEST or a KEY is
 * not a test name, and the harvest stops rather than joining it. "Reads as a
 * digest" is asked as a conjunction, because neither half alone works:
 *
 *   - a bare **length** rule refused `a{40}_{b}{40}_{c}{40}` and `check_` + 30
 *     letters — both names a runner really prints — because they carry long runs.
 *   - a bare **"hex or mixed-alnum"** rule refused `a{40}` too, since a run of one
 *     letter is trivially alphanumeric.
 *
 * So a run is opaque only when it is long AND either all-hex (a SHA/MD5 fragment)
 * or letters-mixed-with-digits (a base64-ish key body, `MIIEvQ…`, `a1B2c3…`). A
 * real name's long run is prose: one alphabet, no digits, and it survives. The
 * rule is asked per separator-free RUN, never of the whole line — `test.sh: failed
 * checks (2), not run (0)` is prose whose runs are at most 6, and a rule that
 * flattened the line before asking would refuse every tally in the stream, the
 * guard silently disabling the feature it guards. Both shapes are pinned by the
 * `-i-` suite. This sits BELOW the reach of the separator-aware secret patterns,
 * which need a prefix or a keyword to anchor on — that is why it is here.
 */
const TALLY_OPAQUE_RUN_MIN = 24;
const HEX_RUN_RE = /^[0-9a-fA-F]+$/;
const DIGIT_RE = /[0-9]/;
// A base64url/standard key body: long, and carrying BOTH letters and digits. A real
// name's long run is one alphabet (`a{40}`, `check_` + 30 letters, `y{120}_0`), so
// the mixed requirement is what separates a key from a slug.
const KEY_BODY_RE = /^(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9+/]+$/;

/** True when any separator-free run inside `name` reads as a digest or a key body. */
function hasOpaqueRun(name: string): boolean {
  for (const run of name.split(/[^A-Za-z0-9+/]+/)) {
    if (run.length < TALLY_OPAQUE_RUN_MIN) continue;
    // A hex run needs a digit to be a digest — `f`.repeat(40) is a slug, and the
    // hex alphabet is a subset of the name alphabet, so the bare shape test would
    // refuse every `deadbeef`-style fixture name a gate might really print.
    if (HEX_RUN_RE.test(run) && DIGIT_RE.test(run)) return true;
    if (KEY_BODY_RE.test(run)) return true;
    // A `+` or `/` inside a long run is not a path separator a test name carries —
    // it is a base64 digit.
    if (run.includes("+") || run.includes("/")) return true;
  }
  return false;
}

/**
 * The THREE-ARM veto a failing-test name must pass before anything prints it.
 *
 * One definition, because the same string reaches two publishers. The tally
 * harvest refuses such a name outright (a name that cannot be named is not
 * evidence), and the base-run prose in
 * `work-driver-verify-base-confirm-prose.ts` must refuse it before a
 * `[baseline-red]` finding, a handoff note or a forge comment quotes it. The
 * prose used to ask only the credential-shape arm, so a bare live-mode secret key, a JWT
 * or a long hex digest — none of which carries the `key=`/`token:` anchor that
 * shape needs — printed in full while the tally silently refused the very same
 * token. A veto that is one arm at one sink and three at another is the bug, not
 * the arms.
 */
export function nameLooksSecret(name: string): boolean {
  return looksLikeCredential(name) || hasOpaqueRun(name) || redactSecrets(name).text !== name;
}

/** The most the ` (+K more)` disclosure may print; beyond it the digit is a claim. */
const TALLY_OMITTED_DISPLAY_MAX = 999;

/**
 * How many joined tally lines one harvest contributes. The record's `push` caps the
 * whole set with every assertion in it at the corrective round's own line cap;
 * capping here too means the harvest never builds evidence the reader is certain to
 * drop — the same number `work-driver-corrective-decide.ts` slices with.
 */
const TALLY_OUTPUT_MAX = 6;

/**
 * The most one joined tally line may carry — the NAMES half of it. The record's
 * own evidence bound is {@link ASSERTION_LINE_MAX}; the tally prefix and the
 * ` (+K more)` disclosure also live on that line, and both are sized by the
 * tally's PRINTED count, which is text from the gate — a `failed checks
 * (1000000)` line makes the suffix 9 characters longer and an 8 KiB prefix
 * possible. So the join is capped well under HALF the evidence bound: that leaves
 * room for prefix and suffix (a count is never realistically printed with hundreds
 * of digits), and the record's `push` redacts and clips the whole
 * line to {@link ASSERTION_LINE_MAX} whatever the gate printed around it.
 */
const TALLY_JOIN_MAX = 250;

/** The bound the record applies to every stored verify line, imported from its owner. */

/** Leading-whitespace width of a raw line (the indentation, measured untrimmed). */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && (raw[n] === " " || raw[n] === "\t")) n++;
  return n;
}

/**
 * Harvest every script-tally block in the consolidated stream into ONE evidence
 * line each: `<tally>: name, name`.
 *
 * THE CONTRACT OF THE WALK, stated once: a candidate stops the harvest, and the
 * tally keeps whatever it gathered up to that point. A candidate is refused when
 * it is no deeper than the tally, when its trimmed form is not a bare token, when
 * it is longer than {@link TALLY_NAME_LINE_MAX}, when it is credential-shaped, or
 * when the classifier recognises it as a failure or a passing line. There is no
 * second "is this still a tally line" test after that walk: the walk stopping is
 * the whole answer, and the joined line is emitted iff at least one name survived
 * it — so no further count or emptiness check is kept here.
 *
 * @param raw the consolidated run's raw failure stream, read line by line with the
 *   indentation intact
 * @returns one joined line per tally that harvested at least one name, in stream
 *   order — `[]` when the stream holds no tally with names beneath it
 */
export function harvestConsolidatedTallies(raw: string): string[] {
  const out: string[] = [];
  const lines = splitLines(raw);
  for (let i = 0; i < lines.length; i++) {
    const rawTally = lines[i] ?? "";
    const tally = rawTally.trim();
    if (tally.length === 0) continue;
    // The tally's own text is part of the emitted line, so the line is bounded by
    // the tally's length too: a 10 KB "tally line" is not evidence and the reader
    // would clip it to noise.
    if (tally.length > TALLY_LINE_MAX) continue;
    const count = scriptTallyCount(tally);
    if (count === undefined) continue;
    const names: string[] = [];
    // The join is built as we go so the bound is checked against the text that
    // would actually be emitted, not against a count.
    let joined = "";
    for (let k = i + 1; k < lines.length && names.length < count; k++) {
      const candidate = lines[k] ?? "";
      if (indentOf(candidate) <= indentOf(rawTally)) break;
      const name = candidate.trim();
      if (name.length === 0 || name.length > TALLY_NAME_LINE_MAX) break;
      if (!NAME_LINE_RE.test(name)) break;
      // All three arms, from their one owner — see {@link nameLooksSecret}.
      if (nameLooksSecret(name)) break;
      if (classifyFailureLine(name) !== undefined) break;
      if (isSuccessLine(name)) break;
      const next = names.length === 0 ? name : `${joined}, ${name}`;
      if (next.length > TALLY_JOIN_MAX) break;
      joined = next;
      names.push(name);
      if (names.length >= TALLY_NAMES_MAX) break;
    }
    if (names.length === 0) continue;
    // K is the gate's claim, not a measurement, so it is displayed under a cap and
    // never negative or fractional — `scriptTallyCount` already refuses a count that
    // is not a safe integer, so the subtraction here is always well-defined.
    const omitted = count - names.length;
    const shown =
      omitted > TALLY_OMITTED_DISPLAY_MAX ? `${TALLY_OMITTED_DISPLAY_MAX}+` : String(omitted);
    out.push(`${tally}: ${joined}${omitted > 0 ? ` (+${shown} more)` : ""}`);
    if (out.length >= TALLY_OUTPUT_MAX) break;
  }
  return out;
}
