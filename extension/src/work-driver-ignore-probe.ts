/**
 * work-driver-ignore-probe — #1421 fix round (lens): the two git reads behind
 * "is this untracked path git's own build output?", split out of
 * `work-driver-dirty-root-classify.ts` so that module stays under the 500-line
 * cap while carrying the classifier, the failure-string builders, and the
 * routing labels that the cap router reads.
 *
 * Same question, two sources, because one cannot answer it alone:
 *
 *   - `readIgnoredPaths` asks `git status --ignored=matching --porcelain -uall`
 *     and gets the paths git itself declares ignored — but with `-uall` git
 *     still COLLAPSES a wholly-ignored directory to one `!! target/` entry and
 *     never prints the files inside it, which is precisely the residue the
 *     incident charged as dirt.
 *   - `probeIgnored` asks `git check-ignore --no-index -- <paths…>`, batching
 *     the candidates into argv groups of ≤`IGNORE_PROBE_BATCH` and running up
 *     to `IGNORE_PROBE_CONCURRENCY` of those batches at a time, which is exact
 *     and independent of how git chose to print the tree.
 *
 * `classifyRootDirt` consults both and needs BOTH to have answered before it
 * exempts anything, so both readers return THREE states, never two: a set (git
 * answered), an empty set (git answered "none"), and `undefined` (git could not
 * answer, so the caller charges every path as dirt). Collapsing the last two is
 * the #481 defect shape — a broken git reading as a clean tree.
 *
 * Why `git status --ignored=matching` is the only safe source for the listing:
 *
 *   - `git check-ignore <path>` is wrong in both directions without
 *     `--no-index`: it reports a TRACKED path that matches a gitignore pattern
 *     as ignored, and the gate is deciding whether that path may hide
 *     uncommitted source.
 *   - Matching `.gitignore` by hand would be a second implementation of git's
 *     pattern language (negation, directory-only patterns, anchoring,
 *     `core.excludesFile`, `.git/info/exclude`) that drifts from the first.
 *   - `--ignored=matching` reports ignored files without walking every
 *     directory of an ignored tree, and marks directories with a trailing `/`.
 */

import { traceWarn } from "./trace.ts";
import { normaliseRepoPath } from "./work-driver-dirty-root-exempt.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #1421 fix round — does this executor report an exit code at all?
 *
 * `ExecFn`'s declared result carries only `stdout`/`stderr`, and the
 * driver's `execp` attaches the exit `code` to the REJECTION only when it
 * comes from execFile/exec — a fake executor, or a rejection that never had a
 * code (a kill with no code, an injected error), leaves it `undefined`.
 * `checkIgnoreStatus` reads the same field the same way; keeping one shape for
 * the question here means the probe and the deps gate cannot disagree about
 * whether git answered.
 */
function exitCodeOf(err: unknown): unknown {
  return (err as { code?: unknown } | undefined)?.code;
}

/**
 * #1421 fix round — the bound on every git read this module makes. Both reads
 * answer a question the cycle's outcome turns on, and a git that HANGS (a lock
 * held by another process, a filesystem that stopped answering) is worse than a
 * git that refuses: a refusal takes the fail-closed branch in milliseconds, a
 * hang parks the dispatch with no verdict at all. Node kills the child at the
 * bound and rejects it `killed` with no exit `code`, which is exactly the shape
 * both readers below treat as "git could not answer" — so the timeout lands on
 * the existing fail-closed path rather than a new one.
 */
const IGNORE_PROBE_TIMEOUT_MS = 30_000;

/**
 * #1421 fix round (lens) — how many paths one `git check-ignore` call is
 * allowed to carry. The batch exists to keep the probe at one git per gate,
 * but the argv grows with the root: an argument list past the kernel's
 * `ARG_MAX` makes execvp fail with E2BIG, which reads as "git could not
 * answer" and charges every untracked path as dirt. 500 keeps the argv well
 * inside any limit worth caring about while staying a single call for every
 * root this harness has seen.
 */
const IGNORE_PROBE_BATCH = 500;

/**
 * #1421 fix round (lens) — how many probe batches run at once. The batches are
 * independent reads of one tree, so running them one after another costs the
 * sum of their latencies for no benefit: a root with 2 000 untracked paths
 * paid four sequential `git check-ignore` round-trips. Four in flight keeps
 * the gate at a fraction of that while staying far below the descriptor and
 * process limits an unbounded fan-out would reach.
 *
 * Module-private on purpose: the offline test asserts the behaviour (it
 * measures the peak number of batches actually in flight) rather than the
 * number, so nothing outside this file needs to name the bound.
 */
const IGNORE_PROBE_CONCURRENCY = 4;

/**
 * Why an ignore probe could not ask git, in the words the trace carries.
 *
 * Both reads answer the same question — "is that path git's own output?" — and
 * both must say so out loud when git will not answer: the caller then charges
 * every untracked path as dirt, so a finished change can park on a git that
 * would not respond. Silence here is the #481 defect shape. `killed` with no
 * exit code is the shape a timeout takes (Node's exec bound kills the child and
 * reports no code), which is why the bound above lands on this branch and
 * therefore on the fail-closed one.
 */
function ignoreProbeFailure(err: unknown): string {
  const e = err as Error & { killed?: boolean };
  const code = exitCodeOf(err);
  const how = typeof code === "number" ? `exit ${code}` : e.killed === true ? "killed" : "error";
  const noCode = typeof code === "undefined" ? ", no exit code reported" : "";
  const detail = (e.message ?? String(err)).slice(0, 200);
  return `(${how}${noCode}): ${detail}`;
}

/**
 * The untracked paths git itself declares ignored, normalised for comparison.
 *
 * Two forms, because the status output cannot answer the whole question. With
 * `-uall`, git lists ignored FILES under a tracked directory (`!! build/out.js`)
 * but collapses a wholly-ignored directory to `!! target/` — so a gate reading
 * only that output would classify `?? target/.cargo-lock` as dirt and refuse,
 * which is the incident. Hence the prefix set plus a batched direct probe —
 * `git check-ignore --no-index`, ≤`IGNORE_PROBE_BATCH` paths per call and up to
 * `IGNORE_PROBE_CONCURRENCY` calls in flight — which is exact and independent
 * of how git chose to print the tree.
 *
 * Both sources come from `git status`, so `.gitignore`, `core.excludesFile`
 * and `.git/info/exclude` all count, and neither reimplements git's pattern
 * language. `--ignored=matching` keeps git from walking every directory of an
 * ignored tree.
 *
 * Returns `undefined` when the read failed — the caller treats that as "I
 * cannot tell", never as "nothing is ignored". A read killed at its bound
 * (IGNORE_PROBE_TIMEOUT_MS) is a failure of the same kind, traced rather than
 * swallowed: silence here is the #481 defect shape.
 */
export async function readIgnoredPaths(
  execFn: ExecFn,
  repoRoot: string,
): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFn("git status --ignored=matching --porcelain -uall", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      timeout: IGNORE_PROBE_TIMEOUT_MS,
    });
    const ignored = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("!!")) continue;
      const norm = normaliseRepoPath(line.slice(2));
      if (norm.length === 0) continue;
      ignored.add(norm);
      // A directory-level ignore (`!! target/`) also covers everything beneath
      // it; register the prefix form so a descendant path matches by prefix.
      ignored.add(norm.replace(/\/$/, ""));
    }
    return ignored;
  } catch (err) {
    // Mirrors `probeIgnored`: a bare `catch` made the one state where this read
    // is unknowable indistinguishable from a quiet "nothing is ignored", and
    // the caller then charges every untracked path as dirt — a finished change
    // parks on a git that would not answer, with nothing saying so.
    traceWarn(
      `work-driver: readIgnoredPaths could not list the ignored paths ${ignoreProbeFailure(err)} — the ignored set is unknown, so every untracked path is charged as dirt (fail closed)`,
    );
    return undefined;
  }
}

/**
 * Which of these untracked paths git declares ignored, asked directly
 * (`git check-ignore --no-index -- <paths…>`) rather than inferred from the
 * status listing, which collapses wholly-ignored directories.
 *
 * ONE git call per BATCH of ≤IGNORE_PROBE_BATCH paths, with up to
 * IGNORE_PROBE_CONCURRENCY batches in flight (the batches are independent
 * reads of one tree, so sequencing them only adds their latencies), in the
 * argv form: a
 * shell string that merely contains the word `git` is indistinguishable from a
 * verify command to an `ExecFn` that counts them separately, and a piped form
 * here was counted as a second verify run and silenced a flake-recovery test.
 * The old docstring described `-z --stdin`; nothing here pipes — the paths are
 * trailing pathspec arguments, so no shell and no stdin are involved.
 *
 * Returns `undefined` when git could not answer any batch, and the caller then
 * fails closed — a partial union would exempt the paths in the batches that
 * answered and leave the rest as dirt, which is a mix no caller can reason
 * about. Three states per batch, exactly as `checkIgnoreStatus` in
 * work-driver-deps-gate.ts reads them:
 *
 *   - exit 0 — the batch printed the ignored subset;
 *   - exit 1 — git ANSWERED: nothing in the batch is ignored. That is a real
 *     empty set, not a failure, and conflating the two is what made a clean
 *     tree indistinguishable from a broken git;
 *   - anything else (exit ≥ 2, a spawn failure, a kill — including the
 *     IGNORE_PROBE_TIMEOUT_MS bound — or a rejection that reports no code at
 *     all) — git could not answer. The set is `undefined`, the reason is
 *     traced, and a caller that cannot tell must charge every path as dirt.
 *
 * `-q` is deliberately absent: it would suppress exactly the list we came for.
 */
export async function probeIgnored(
  execFn: ExecFn,
  repoRoot: string,
  lines: readonly string[],
): Promise<Set<string> | undefined> {
  const candidates: string[] = [];
  for (const line of lines) {
    // `!!` lines are git's own answer already — nothing to ask about them.
    if (!line.trimStart().startsWith("??")) continue;
    const path = normaliseRepoPath(line.slice(2));
    if (path.length > 0) candidates.push(path);
  }
  const out = new Set<string>();
  if (candidates.length === 0) return out;
  const batches: string[][] = [];
  for (let start = 0; start < candidates.length; start += IGNORE_PROBE_BATCH) {
    batches.push(candidates.slice(start, start + IGNORE_PROBE_BATCH));
  }
  // #1421 fix round (lens) — the batches run concurrently, bounded to
  // IGNORE_PROBE_CONCURRENCY in flight by a cursor each worker advances: no
  // queue, no dependency, and the number of simultaneous children never
  // grows with the size of the root. Failure semantics are UNCHANGED — any
  // rejection that is not git's exit-1 answer still voids the whole answer,
  // so the fail-closed contract does not depend on the order the batches
  // settle in. Each worker catches its own rejection so a pool member never
  // becomes an unhandled rejection while its siblings are still running.
  let next = 0;
  // `undefined` = no batch has failed; `true` = one did. A sentinel rather
  // than the error itself, because a rejection whose only payload is `code:
  // undefined` must still void the answer — the same three-state discipline
  // the rest of this module keeps. `lastFailure` carries the reason the trace
  // prints.
  let failed = false;
  let lastFailure: unknown;
  const runBatch = async (batch: string[]): Promise<Set<string>> => {
    const found = new Set<string>();
    try {
      // `git check-ignore` also reads paths from `--stdin`, but passing the
      // batch as trailing pathspec arguments is equivalent, needs no shell and
      // no pipe, and keeps the call a single argv-form git invocation. Paths
      // come from git's own status output, so they are relative and cannot be
      // options; `--` is the guard that keeps a path beginning with a dash a
      // path.
      const { stdout } = await execFn("git", {
        cwd: repoRoot,
        maxBuffer: 4 * 1024 * 1024,
        timeout: IGNORE_PROBE_TIMEOUT_MS,
        argv: ["check-ignore", "--no-index", "--", ...batch],
      });
      for (const line of stdout.split("\n")) {
        const norm = normaliseRepoPath(line);
        if (norm.length > 0) found.add(norm);
      }
      return found;
    } catch (err) {
      const e = err as Error & { killed?: boolean };
      const code = exitCodeOf(err);
      // Exit 1 is git's answer, not git's failure: "none of these are ignored".
      // The empty set is then correct information, and the caller keeps its
      // fail-closed dirt list on the strength of the read, not a guess.
      if (code === 1 && e.killed !== true) return found;
      lastFailure = err;
      failed = true;
      return found;
    }
  };
  const worker = async (): Promise<void> => {
    while (!failed && next < batches.length) {
      const batch = batches[next];
      next++;
      if (batch === undefined) continue;
      for (const norm of await runBatch(batch)) out.add(norm);
    }
  };
  const pool: Promise<void>[] = [];
  for (let i = 0; i < Math.min(IGNORE_PROBE_CONCURRENCY, batches.length); i++) {
    pool.push(worker());
  }
  await Promise.all(pool);
  if (failed) {
    traceWarn(
      `work-driver: probeIgnored could not ask git ${ignoreProbeFailure(lastFailure)} — the ignored set is unknown, so every untracked path is charged as dirt (fail closed)`,
    );
    // Fail CLOSED on the whole answer, not the batch: a union of the batches
    // that answered would exempt paths on a partial read.
    return undefined;
  }
  return out;
}
