/**
 * lean/verify-baseline-harness — the HARNESS's own writing, and what it may be excused by.
 *
 * The half of the baseline excuse that answers WHO WROTE the line rather than what it says. The
 * streams the excuse reads are BUILT by the executor, which adds its own writing to what the gate
 * printed — a `tier-said-<name>` marker, a `boom from the <tier>`, a bare `Exit code: N`, a bare
 * `killed`, a traced `$ command`, a `Command failed: <cmd>` echo — and none of it is evidence about
 * the project. Split from `verify-baseline-allow-list.ts` along that seam: that file answers what a
 * head-only line may BE, this one answers which lines are not the gate's to be judged at all, and
 * both are read by {@link judgeableLines} behind one invariant.
 *
 * THE INVARIANT THE HARNESS ARMS OWE, stated once here because both doors ask it. An exemption is a
 * statement about WHO wrote a line, and it must not become a statement about what the line REPORTS,
 * so {@link declaresFailure} is consulted before any exemption takes effect: {@link
 * isHarnessEchoOf} asks it of the echoed command, and `judgeableLines` in the allow-list module asks
 * it of every line before either harness or passing-check door is opened. What is discounted by
 * {@link harnessWordsRemoved} is the executor's PREFIX — `Command failed:` and the `$ `/`+ ` trace
 * markers, printed on every failed command, whose spelling is not a runner declaring a failure — and
 * nothing else's text is discounted. The harness's own kill stamps (`killed`, `Exit code: N`) keep
 * their words: they are excused by {@link isHarnessLine} on their own shape, never by having their
 * words removed from the invariant.
 */

import { scrubInvisible } from "./verify-baseline-scrub.ts";
import { declaresFailure } from "./verify-baseline-veto.ts";

/**
 * Did the HARNESS write this line, rather than the gate?
 *
 * The streams the excuse reads are BUILT by the executor, which adds its own writing to what
 * the gate printed: a `tier-said-<name>` marker, a `boom from the <tier>`, a bare `Exit code:
 * N`, a bare `killed`, an echoed `$ command`. None of it is evidence about the project, so the
 * default-refuse rule must not read it as a gate line — and it must not read it on EITHER
 * side, because the head stream carries executor noise the base stream need not carry
 * identically, and counting that as head-only would refuse every real tier in the suite.
 *
 * The arms are anchored to the harness's OWN full-line forms, exactly as `isHarnessEchoLine`
 * anchors the shared table's: a bare `Exit code: 1` is the harness, while `Exit code: 1 - brand
 * new check` is a gate line that merely OPENS that way and is judged on what it says. An
 * exemption that reached the second form would hand the whole rule back to whoever controls the
 * first word of a line.
 */
export function isHarnessLine(line: string): boolean {
  const t = scrubInvisible(line).trim();
  return (
    /^tier-said-[A-Za-z0-9_-]+(?:-\d+)?$/.test(t) ||
    /^boom from the [A-Za-z0-9_ -]+$/.test(t) ||
    /^Exit code:\s*\d*$/.test(t) ||
    /^killed(?:\s+by\s+signal\s*\S*)?$/i.test(t) ||
    /^\$\s/.test(t)
  );
}

/**
 * The harness's own writing, discounted from the whole-line veto.
 *
 * `Command failed:` is the executor's sentence, printed on EVERY failed command, so its word is not
 * a runner declaring a failure — read as content it would veto the tier's echo of its own clean
 * command (`Command failed: pnpm run lint`, or `Command failed: sh -c 'pnpm run test --
 * --fail-fast'` where only the caller's flags spell `fail`) and refuse the case the echo arm exists
 * to excuse. The `$ ` / `+ ` shell trace prefixes are discounted the same way: a traced command line
 * is evidence about WHO wrote the line, not about what the run reported.
 *
 * WHY REMOVING THE PREFIX DOES NOT WIDEN THE EXEMPTION, which is the property this helper exists to
 * keep: the two doors that could read a discount as a pardon are asked of the RAW line, before and
 * after it. {@link isHarnessLine} — the door that excuses a `$ `-prefixed line outright — and
 * {@link isPassingLine} — the door that excuses what the classifier reads as a passing check — are
 * both consulted on the untouched text in {@link judgeableLines}, and {@link isHarnessEchoOf} offers
 * its exemption only to a line whose own shape test put `Command failed:` at position 0. So the text
 * discounted here is text whose exemption was already earned by the harness's own full-line form,
 * while `$ not ok 1 - t/brand_new.t - boom` is none of those forms and the veto's `not ok` arm
 * catches it on the stripped text regardless. A gate line that merely QUOTES one of these sentences
 * keeps its words as content, because quoting buys nothing: the prefix is discounted, not believed.
 *
 * WHAT IS NOT DISCOUNTED, and the boundary a helper that strips a prefix has to state: only the
 * PREFIX. An earlier version blanked the whole line whenever the stripped text was one of {@link
 * isHarnessLine}'s own forms, and that read as a pardon for the harness's kill stamps — `killed`,
 * `killed by signal SIGTERM`, `Exit code: 1` are all harness forms and all spell failures, so the
 * invariant came back declaring nothing and a head-only kill was graded green over a run nothing
 * judged. The harness door excuses those lines on their OWN shape, on the raw text; the invariant's
 * job is to keep them in the stream for anything else, and an empty string here is how it stopped
 * doing that job. A `$ `-prefixed line whose text behind the prefix names no failure — `$ bats t/` —
 * is the case the discount is FOR, and it keeps its exemption.
 */
export function harnessWordsRemoved(line: string): string {
  return line.replace(/^\s*(?:Command failed:|\$\s+|\+\s+)/i, "").trim();
}

/**
 * Is this head line the harness ECHOING a command, and did the base echo the same command?
 *
 * `Command failed: <cmd>` is the executor quoting back what it ran. It is not gate output, and
 * the same tier at the base is echoed the same way, so an echo is not a failure this run
 * authored — PROVIDED the base really printed that command, or it is the tier's own command
 * (which the caller passes, because the base stream of a single-tier probe need not repeat it).
 * That proviso is what keeps the exemption honest: an echo of a command NEITHER run was asked to
 * run is a head-only line like any other, and a head carrying only such an echo has nothing
 * recognised left to compare, which is what refuses it.
 *
 * THE INVARIANT, asked FIRST, is what makes this one of the two places an exemption is applied
 * rather than a third exemption: {@link declaresFailure} keeps any line whose text declares a
 * failure vouchable by nothing but the base's copy of the identical raw line. One span is excluded
 * from that reading, and it is the harness's OWN marker: `Command failed:` is the executor's
 * sentence, printed on EVERY failed command, so it is not a runner declaring a failure — read as
 * one, the word in the harness's own prefix would veto the tier's echo of its own clean command
 * (`$ bats t/`, `Command failed: pnpm run lint`) and refuse the case the arm exists to excuse. The
 * INVARIANT therefore reads the ECHOED COMMAND, the only part of the line the harness did not write
 * verbatim, and the harness prefix is exempt exactly as it is in {@link isHarnessLine}. What the
 * command string carries is still the gate's concern: `Command failed: sh -c 'pnpm run test --
 * --fail-fast'` declares a failure in what it quoted, so the caller's command is not enough for it.
 * The reason is what the two vouchsafes actually prove — a matching {@link tierCommand} proves what
 * the harness was ASKED to run and says nothing about what the run REPORTED, while the base's
 * identical line is evidence that this exact harness writing appeared in BOTH runs, which is the
 * property the exemption rests on, and it remains available. A command no word list reads keeps the
 * ordinary echo rule, so an echo of a clean command is exempt on the caller's command as before.
 *
 * The command is NEVER read back out of the stream being judged. It is the tier's real command,
 * which only the CALLER knows — the thing `verify`/`ci` asked the executor to run — and a rule
 * that mined the expected command out of the head stream would let a head-only `Command failed:
 * touch /tmp/pwned` quote itself into being the command the tier ran.
 *
 * The base's copy vouches only when the base printed the IDENTICAL RAW LINE — `l.trim() ===
 * headLine.trim()`, the whole echo including its own `Command failed:` marker. Comparing the
 * STRIPPED command against the base's raw lines inverted the arm: a base carrying the bare command
 * as gate output (`touch /tmp/pwned`) vouched for a head echo nothing asked to run, while the base's
 * own identical echo line did not vouch at all. A base that ran the tier echoes the tier, so the
 * identical echo is exactly the evidence the arm may read, and a line that only MENTIONS the command
 * — a `make check` that quoted the pnpm invocation in its own output, a bare command the runner
 * printed itself — records that the base named it, not that the harness echoed it. With no
 * caller-supplied command that identical echo is the ONLY vouchsafe, and an echo the base did not
 * print is a head-only line like any other — including an empty echo, which names no command at all
 * and so proves nothing.
 */
export function isHarnessEchoOf(
  headLine: string,
  baseRawLines: readonly string[],
  tierCommand: string | undefined,
): boolean {
  const t = scrubInvisible(headLine).trim();
  if (!/^Command failed:\s/.test(t)) return false;
  const echoed = t.slice("Command failed:".length).trim();
  if (echoed.length === 0) return false;
  const asked = tierCommand?.trim();
  const isTierOwnCommand = asked !== undefined && asked.length > 0 && echoed === asked;
  // The invariant, before the caller's command is allowed to vouch, asked of the ECHOED COMMAND
  // rather than the whole line — `Command failed:` is the harness's own sentence and its word is not
  // a runner declaring a failure ({@link harnessWordsRemoved}). The distinction is what an echo can
  // be evidence ABOUT: it records that the harness INVOKED a command, never what that command found,
  // so the `FAILED tests/x.py::t` inside a tier's own `echo "…"` argument is a word the tier was
  // TOLD to print, not a check it declared — read as a verdict it would hand back every tier whose
  // command merely mentions a failure word. A command the caller did not name is a different matter:
  // an echo nobody asked for vouches for nothing on its own name, so the base's identical line is
  // then the only evidence, which is what stops a head-only `Command failed: touch /tmp/pwned` from
  // quoting itself into being the tier's command.
  if (declaresFailure(harnessWordsRemoved(echoed)) && !isTierOwnCommand)
    return baseRawLines.some((line) => line.trim() === t);
  if (isTierOwnCommand) return true;
  // The WHOLE head line, marker included, compared to the whole base line. Stripping the marker
  // before this comparison is what inverted the arm (see the jsdoc).
  return baseRawLines.some((line) => line.trim() === t);
}
