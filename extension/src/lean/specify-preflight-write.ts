/**
 * lean/specify-preflight-write — the probe file's three filesystem acts.
 *
 * Split from `specify-preflight.ts` for the §12 line cap, and split along a real
 * seam rather than an arbitrary one: these are the three calls that touch the
 * worktree's bytes, as opposed to the ones that decide where the probe goes and
 * what its answer means. The write is the act with a security rule on it, so it is
 * the act worth being able to read on its own.
 *
 * The rule the whole module exists for: the step owns the worktree's bytes, and a
 * name the base already carries as a link, a directory or a fifo is not a place to
 * put a probe — nor is it a probe the runner would run.
 */

import { lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Proof } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { oneLine } from "./text-fence.ts";

/**
 * The disclosure this step records when the runner ran and refused the probe file.
 *
 * The fact that exit 4 was read as the PROBE being rejected, not as a runner that
 * cannot run tests. Recorded on the step's outcome, never as a verdict about the issue.
 */
export const PROBE_REJECTED = "the runner rejected the probe file (exit 4)";

/**
 * How much of the rendered command the disclosure quotes.
 *
 * The sibling clip in `publish-body.ts` is what a printed command gets there
 * (`PREEXISTING_COMMAND_CLIP`); this is the same bound for the same reason — the
 * template is project-authored text, it lands in a reason line the operator reads,
 * and the interesting part is the front of it.
 */
const REJECTED_COMMAND_CLIP = 119;

/** The note's own worst case: the prefix, the separator, and a command at its clip width. */
const probeNoteWorstCase = (): string => `${PROBE_REJECTED}: ${"a".repeat(REJECTED_COMMAND_CLIP)}`;

/** The bound handed to `oneLine` for one note: prefix, separator, command at its clip width. */
const PROBE_NOTE_SLICE_BOUND = REJECTED_COMMAND_CLIP + PROBE_REJECTED.length + ": ".length;

/**
 * The longest note this renderer can return.
 *
 * DERIVED by running the renderer on its worst case, not declared from arithmetic
 * over its parts: `oneLine` appends its ellipsis AFTER the slice and trims and
 * collapses space runs, all of which change the length a hand-written sum over the
 * parts would predict. Measuring the renderer here keeps the bound true by
 * construction, and lets the assertion that reads it fail on a real widening rather
 * than on someone's arithmetic. The note is JOINED onto the step's own reason, so the
 * clause this step contributes has to be as bounded as the sentence it is added to.
 */
export const PROBE_NOTE_MAX_CHARS = oneLine(probeNoteWorstCase(), PROBE_NOTE_SLICE_BOUND).length;

/**
 * The disclosure line for one proof — the note names the rendered command, clipped
 * to the bound above, which is a RENDERED length and so already carries the
 * ellipsis.
 *
 * `oneLine` and not a bare interpolation, because `proof.cmd` is the project's own
 * `verify.test` template: a template with a newline in it would end the reason line
 * this note is joined onto, and a `|` would open a column in the table it is
 * eventually printed in. The bound is the whole note rather than just the command.
 */
export function probeRejected(proof: Proof): string {
  return oneLine(`${PROBE_REJECTED}: ${proof.cmd}`, PROBE_NOTE_MAX_CHARS - 1);
}

/**
 * Is `abs` an ordinary file this probe may claim (rather than a link, dir or fifo)?
 *
 * `lstat`, never `stat`: the question is what sits AT the name, not what the name
 * resolves to. The link is refused by name rather than by inference —
 * `isSymbolicLink()` before `isFile()` — because this is the step's own rule, not
 * the platform's.
 *
 * Module-private: the only caller is `probeWrite`.
 */
function isPlainProbe(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Write the empty probe at `rel`, or hand back naming why it could not.
 *
 * The guard asks `lstatSync` whether ANYTHING is at the name — not `existsSync`,
 * which follows links and so reports a dangling symlink as nothing there. That
 * difference is the whole guard: for a dangling link `existsSync` says "clear" and
 * `wx` then answers `EEXIST`, and the operator is handed a raw `EEXIST` naming a file
 * that appears not to exist. Asked this way, every existing inode that is not a plain
 * file is the named refusal.
 *
 * `wx` still carries the race: a name that appeared between the check and the
 * write is refused rather than opened. The check before it exists to give the
 * operator a message that names the path, which `wx`'s EEXIST does not.
 */
export function probeWrite(wt: string, rel: string): void {
  const abs = path.join(wt, rel);
  if (lstatExists(abs) && !isPlainProbe(abs)) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${rel} already exists in ${wt} and is not a plain file`,
    );
  }
  try {
    writeFileSync(abs, "", { flag: "wx", mode: 0o644 });
  } catch (err) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${(err as Error).message}`,
    );
  }
}

/** Is there any inode at `abs`, following no links? ENOENT is the only "no". */
function lstatExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the probe, never throwing.
 *
 * A probe left in the tree is an untracked byte the reset's clean-tree assertion and
 * the acceptance-test commit both have to explain, so this runs on every path
 * including the throw; and a probe that cannot be removed is left to the reset's own
 * `clean -fdx` rather than replacing the caller's error with one about a file.
 */
export function removeProbe(wt: string, rel: string): void {
  const abs = path.join(wt, rel);
  if (!lstatExists(abs)) return;
  try {
    unlinkSync(abs);
  } catch {
    /* the reset's `clean -fdx` removes it whatever happens here */
  }
}
