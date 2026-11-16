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

import { existsSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Proof } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";

/** A probe file the runner can parse and collect nothing from, in any language. */
const PROBE_CONTENT = "";

/**
 * The disclosure this step records when the runner ran and refused the probe file.
 *
 * Named for what the operator has to be able to find: the fact that exit 4 was read
 * as the PROBE being rejected, not as a runner that cannot run tests. Recorded on
 * the step's outcome and never as a verdict about the issue.
 */
export const PROBE_REJECTED = "the runner rejected the probe file (exit 4)";

/** The disclosure line for one proof — the note names the rendered command. */
export function probeRejected(proof: Proof): string {
  return `${PROBE_REJECTED}: ${proof.cmd}`;
}

/**
 * Is `abs` an ordinary file this probe may claim (rather than a link, dir or fifo)?
 *
 * `lstat`, never `stat`: the question is what sits AT the name, not what the name
 * resolves to. The link is refused by name rather than by inference —
 * `isSymbolicLink()` before `isFile()` — because this is the step's own rule, not
 * the platform's: a base-carried symlink at the probe path is never written
 * through, whatever `open(2)` with `wx` would have happened to do with it.
 */
export function isPlainProbe(abs: string): boolean {
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
 * `wx`, so a name that appeared between the check and the write is refused rather
 * than opened — the check before it exists to give the operator a message that
 * names the path, which `wx`'s EEXIST does not.
 */
export function probeWrite(wt: string, rel: string): void {
  const abs = path.join(wt, rel);
  if (existsSync(abs) && !isPlainProbe(abs)) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${rel} already exists in ${wt} and is not a plain file`,
    );
  }
  try {
    writeFileSync(abs, PROBE_CONTENT, { flag: "wx", mode: 0o644 });
  } catch (err) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${(err as Error).message}`,
    );
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
  if (!existsSync(abs)) return;
  try {
    unlinkSync(abs);
  } catch {
    /* the reset's `clean -fdx` removes it whatever happens here */
  }
}
