/**
 * merged-head-refusals — the shared STUB clone for the #1533 head-verification
 * suite, split from lib/merged-head-fixtures.ts (the §12 500-line cap).
 *
 * The suite needs two kinds of fixture and they answer different questions. The
 * moved-head cases run against a real clone with real commits, because there the
 * patch identity IS the verdict and only git may answer it. Everything else — the
 * refusals — runs against this stub, because there the question is not "what does
 * git say about these two commits" but "what does the check do when a read fails",
 * and a fixture that cannot fail cannot test that.
 *
 * THE STUB ANSWERS EVERY READ, including the ones a case does not exercise. That
 * is deliberate: a refusal is only attributable to the check when every other read
 * answered successfully. A stub that simply returned nothing everywhere produces a
 * park that looks exactly like the one under test, and the case then passes for a
 * reason no one would choose — which is how "fetch failed" and "the ledger is
 * missing" become the same green assertion. Each option below therefore withholds
 * ONE read and leaves the rest answering, and the doc on each says which refusal
 * that option is the way to pose.
 *
 * Reads are matched on their WORDS, not their shape: the production executor runs
 * an argv call through `execFile` and a string call through a shell, and the check
 * under test uses both — a matcher keyed to one shape answers nothing for the
 * other, and the check then parks on a read the fixture never served.
 */

import { MERGE_BASE, PATCH } from "./merged-head-fixtures.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeGitOpts {
  /** Make the network fetch fail. */
  failFetch?: boolean;
  /** Answer no remote at all (the honest answer: no URL, and no remotes listed). */
  noRemote?: boolean;
  /** Answer no mainline at all. */
  noMainline?: boolean;
  /** What `git patch-id` answers. `""` is "the identity could not be computed". */
  patchId?: string;
  /** Suppress the identity read for the diff naming this OID, simulating a commit the clone lacks. */
  missingIdentityOf?: string;
}

/**
 * A stand-in clone answering every git read the head verification makes, so each
 * refusal is attributable to the check and not to an absent fixture. The
 * moved-head cases use `realClone` instead, for the reason given there.
 */
export function fakeClone(opts: FakeGitOpts = {}): {
  dir: string;
  exec: VerifyExecFn;
  calls: string[];
} {
  const dir = mkdtempSync(path.join(tmpdir(), "mhead-fake-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  const calls: string[] = [];
  const exec: VerifyExecFn = async (cmd: string, o?: { argv?: string[] }) => {
    const args = o?.argv ?? cmd.split(" ").slice(1);
    const line = ["git", ...args].join(" ");
    calls.push(line);
    const verb = args[0];
    if (args.includes("--git-common-dir")) return { stdout: `${dir}/.git\n` };
    if (verb === "config" && args.some((a) => a.startsWith("remote.")))
      return opts.noRemote
        ? Promise.reject(new Error("no such remote"))
        : { stdout: "https://example.invalid/r.git\n" };
    if (verb === "remote") return opts.noRemote ? { stdout: "" } : { stdout: "origin\n" };
    if (verb === "symbolic-ref")
      return opts.noMainline
        ? Promise.reject(new Error("no origin/HEAD"))
        : { stdout: "origin/main\n" };
    if (verb === "fetch")
      return opts.failFetch ? Promise.reject(new Error("network down")) : { stdout: "" };
    if (verb === "merge-base") return { stdout: `${MERGE_BASE}\n` };
    if (line.includes("patch-id")) {
      // A suppressed or empty answer is "the identity could not be computed",
      // which is its own refusal case: one side missing is not evidence of
      // equality, and inventing an id here would test a different branch.
      if (opts.patchId === "") return { stdout: "" };
      if (opts.missingIdentityOf !== undefined && line.includes(opts.missingIdentityOf))
        return { stdout: "" };
      return { stdout: `${opts.patchId ?? PATCH} x\n` };
    }
    return { stdout: "" };
  };
  return { dir, exec, calls };
}

/** True when the fake/stub executor was ever asked to fetch. */
export function fetched(calls: readonly string[]): boolean {
  return calls.some((l) => l.includes("fetch"));
}
