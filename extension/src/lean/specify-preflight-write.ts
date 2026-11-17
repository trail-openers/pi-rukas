/**
 * lean/specify-preflight-write — the probe file's three filesystem acts.
 *
 * Split from `specify-preflight.ts` for the line cap, along a real seam: these are the three calls
 * that touch the worktree's bytes, as opposed to the ones that decide where the probe goes and what
 * its answer means. The write is the act with a security rule on it.
 *
 * The rule the whole module exists for: the step owns the worktree's bytes, and a name the base
 * already carries as a link, a directory or a fifo is not a place to put a probe.
 */

import { lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Proof } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { oneLine } from "./text-fence.ts";

/**
 * The disclosure this step records when the runner ran and refused the probe file.
 *
 * The fact that exit 4 was read as the PROBE being rejected, not a runner that cannot run tests. Recorded on
 * the step's outcome, never as a verdict about the issue.
 */
export const PROBE_REJECTED = "the runner rejected the probe file (exit 4)";

/**
 * How much of the rendered command the disclosure quotes. Same bound as the sibling clip in
 * `publish-body.ts`, for the same reason: the template is project-authored text landing in a reason line the
 * operator reads.
 */
const REJECTED_COMMAND_CLIP = 119;

/** The note's own worst case: the prefix, the separator, and a command at its clip width. */
const probeNoteWorstCase = (): string => `${PROBE_REJECTED}: ${"a".repeat(REJECTED_COMMAND_CLIP)}`;

/** The bound handed to `oneLine` for one note: prefix, separator, command at its clip width. */
const PROBE_NOTE_SLICE_BOUND = REJECTED_COMMAND_CLIP + PROBE_REJECTED.length + ": ".length;

/**
 * The longest note this renderer can return.
 *
 * DERIVED by running the renderer on its worst case, not from arithmetic over its parts: `oneLine` appends
 * its ellipsis AFTER the slice and trims and collapses space runs, all of which change the length a
 * hand-written sum predicts. Measuring the renderer keeps the bound true by construction. The note is JOINED
 * onto the step's reason, so this step's clause must be as bounded as that sentence.
 */
export const PROBE_NOTE_MAX_CHARS = oneLine(probeNoteWorstCase(), PROBE_NOTE_SLICE_BOUND).length;

/**
 * The disclosure line for one proof: the note names the rendered command, clipped to the bound above — a
 * RENDERED length, so it already carries the ellipsis.
 *
 * `oneLine`, not a bare interpolation, because `proof.cmd` is the project's own `verify.test` template: a
 * newline ends the reason line this joins onto, and a `|` opens a column in the table it is printed in.
 */
export function probeRejected(proof: Proof): string {
  return oneLine(`${PROBE_REJECTED}: ${proof.cmd}`, PROBE_NOTE_MAX_CHARS - 1);
}

/**
 * Is `abs` an ordinary file this probe may claim (rather than a link, dir or fifo)?
 *
 * `lstat`, never `stat`: the question is what sits AT the name, not what it resolves to. The link is refused
 * by name rather than inference — `isSymbolicLink()` before `isFile()`. Only caller is `probeWrite`.
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
 * The guard asks `lstatSync` whether ANYTHING is at the name — not `existsSync`, which follows links and
 * reports a dangling symlink as nothing there. That difference is the whole guard: for a dangling link
 * `existsSync` says "clear" and `wx` answers `EEXIST`, handing the operator a raw error naming a file that
 * appears not to exist.
 *
 * `wx` still carries the race — a name that appeared between check and write is refused, not opened. The
 * check before it exists to give the operator a message naming the path.
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
 * A probe left in the tree is an untracked byte the reset's clean-tree assertion and the acceptance-test
 * commit both explain, so this runs on every path including the throw; one that cannot be removed is left to
 * the reset's `clean -fdx`.
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
