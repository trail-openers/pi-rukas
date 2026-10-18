/**
 * worktree-provision-verify — #765 post-hook / post-symlink filesystem
 * verification helpers for `provisionWorktree`.
 *
 * Extracted from `worktree-provision.ts` (file-size cap). The functions here
 * answer ONE question: after provisioning, does the expected dependency
 * location actually exist, resolve, and contain content?
 *
 * #1394 adds a second invariant these functions must never break: **a probe
 * fault is a reported value, never a rejection.** Every `fs` call in this file
 * funnels through `probeNonEmptyDirectory`, which returns
 * `{ nonEmpty, empty, fault? }`. That matters because `provisionWorktree` sits
 * on the branch step's critical path and AGENTS.md §7 promises provisioning
 * never fails it: when `isNonEmptyDirectory` re-threw `EACCES`, an unreadable
 * gitignored `node_modules` — a directory, not a file, so `access`-style checks
 * do not cover it — turned `provisionWorktree` into a rejected promise, which
 * `worktreeCreate` propagated, which failed the mechanized branch setup, which
 * fell to the LLM ops dispatch or halted `commit-pr`. The fault is real and
 * worth reporting; it is not worth a throw for.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SHAREABLE_DEPS } from "./worktree-dep-contract.ts";
import { type ExecFn, ignoredStatus } from "./worktree-provision.ts";
import type { IgnoreVerdict } from "./worktree-provision.ts";

/** A directory probe that cannot fail: what it found, and why if it could not look. */
export interface NonEmptyProbe {
  nonEmpty: boolean;
  /**
   * `true` only when the directory EXISTS and has no entries. `ENOENT` is
   * "absent", not "empty" — the distinction is what makes an absent tree a
   * non-event and an empty one the #481 finding.
   */
  empty: boolean;
  /** `EACCES: permission denied…` when the probe itself faulted. */
  fault?: string;
}

/**
 * Read a directory without ever rejecting.
 *
 * Three answers, not two: `ENOENT` is "absent" (the expected answer for a tree
 * that was never installed); an existing directory with no entries is
 * `empty` (#481's "an empty `node_modules` is not a useful link"); anything
 * else — `EACCES`, `ELOOP`, `ENOTDIR`, `EOVERFLOW` — is a `fault` the caller
 * reports. Pre-#1394 the fault was re-thrown ("anything else is a fault the
 * caller must hear about") which was right about the diagnosis and wrong about
 * the mechanism: the caller's only sane use of a fault here is a string.
 */
async function probeNonEmptyDirectory(abs: string): Promise<NonEmptyProbe> {
  try {
    const nonEmpty = (await fs.readdir(abs)).length > 0;
    return { nonEmpty, empty: !nonEmpty };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { nonEmpty: false, empty: false };
    return { nonEmpty: false, empty: false, fault: errnoDetail(err) };
  }
}

/** `EACCES: permission denied, scandir '…'` — code first, then a bounded message. */
function errnoDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  const code = typeof e?.code === "string" ? e.code : "unknown";
  const message = typeof e?.message === "string" ? e.message : String(err);
  // Node's errno message already begins with the code, so prefixing it printed
  // `EACCES: EACCES: permission denied…`. The code is the token a reader (and a
  // test) greps for, so it is kept once — a duplicated prefix is just noise in
  // the ~80-char window a `problem` actually gets.
  const detail = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  return `${code}: ${detail.slice(0, 120)}`;
}

function candidatesForDir(dirRel: string): string[] {
  return dirRel === "" ? [...SHAREABLE_DEPS] : SHAREABLE_DEPS.filter((d) => d === "node_modules");
}

/** One candidate location: `<dirRel>/<basename(source)>` is a dependency tree. */
export interface DepLocation {
  dirRel: string;
  source: string;
  /**
   * The `git check-ignore` verdict this module reached for `rel` — the single
   * probe call shared with the provisioning path, computed once per candidate
   * so no caller needs a second opinion. `"unreadable"` is the fourth state:
   * the probe never ran because `readdir` itself faulted. A caller that
   * distinguishes "the tree is not gitignored, so its absence is not our
   * problem" from "we could not ask" reads this field.
   */
  status: IgnoreVerdict | "unreadable";
  /**
   * Set only when `status === "unreadable"`, and never on a probe of git: the
   * errno from the `readdir` that never let the probe run.
   */
  fault?: string;
  /**
   * Set only when `status === "git-error"`: git's own words, so a caller can
   * name the failure it has no other way of knowing (`fatal: .git/index: index
   * file smaller than expected` is the whole diagnosis).
   */
  detail?: string;
}

/** What `expectedDepLocations` learned: the expectation, and what it could not determine. */
export interface ExpectedDeps {
  /**
   * The dependency locations a provisioned worktree is expected to have.
   * Includes candidates whose ignore status git could not answer — see
   * `undetermined` — because dropping them is the bug, not the fix.
   */
  locations: DepLocation[];
  /**
   * Candidates this module could not resolve to an answer, each
   * `"<rel>: <cause>"`. Two causes land here and both are "the probe could not
   * run", never "the probe said no":
   *
   *   - `git could not determine ignore status` — `git check-ignore` exited ≥2
   *     (a corrupt index, not a repo, a permission error on the object store).
   *   - an errno — `readdir` faulted (EACCES on the tree itself).
   *
   * A probe error is NOT "not ignored": treating it that way shrank the
   * expectation to `[]`, which read as "nothing to verify" and emitted no
   * problem at all — so a repo whose index git cannot read passed both the
   * hook verification and the develop gate. Kept in `locations` AND named here
   * so a hook that did everything right is not falsely accused
   * (`test-worktree-provision-1146.ts`'s corrupt-index case) while a silent
   * hook still is.
   */
  undetermined: string[];
}

/**
 * The dependency locations the driver should EXPECT a provisioned worktree to
 * have: the non-empty candidates under `repoRoot` and the discovered package
 * dirs that are gitignored, which is the set `provisionWorktree`'s symlink path
 * links and the hook is expected to link.
 *
 * `dirRel === ""` is the `repoRoot` itself; only `node_modules` is
 * conventionally nested in a package dir.
 *
 * #1146 — every location, not the first per dep name: pi-rukas has a
 * non-empty root `node_modules` (a jiti compile cache) AND its real tree at
 * `extension/node_modules`. First-wins verified only the root one, so a hook
 * that linked the tree the verify command needs still read as hook-failed,
 * and a missing nested tree was never noticed.
 *
 * #1394 — three corrections, all in the same direction (an unknown must never
 * read as a clean answer):
 *
 *   - **the probe is required.** `execFn` used to be optional and its
 *     absence silently skipped the gitignore filter, so the same function
 *     answered two different questions depending on which caller reached it.
 *     The caller that genuinely does not want the probe — the hook's "does the
 *     source tree exist at all?" precondition — calls
 *     `anyLinkableSharedSource` below, which is a different question with a
 *     different name.
 *   - **git-error candidates stay in the expectation** (see `undetermined`).
 *   - **probe faults are returned, not pushed into an out-array** the caller
 *     has to remember to declare — and a caller that forgot could not tell "no
 *     faults" from "faults I never collected".
 */
export async function expectedDepLocations(
  repoRoot: string,
  packageDirs: string[],
  execFn: ExecFn,
): Promise<ExpectedDeps> {
  const locations: Array<{ dirRel: string; source: string }> = [
    { dirRel: "", source: repoRoot },
    ...packageDirs.map((d) => ({ dirRel: d, source: path.join(repoRoot, d) })),
  ];
  const found: DepLocation[] = [];
  const undetermined: string[] = [];
  for (const dep of SHAREABLE_DEPS) {
    for (const { dirRel, source } of locations) {
      if (!candidatesForDir(dirRel).includes(dep)) continue;
      const rel = path.join(dirRel, dep);
      const probe = await probeNonEmptyDirectory(path.join(source, dep));
      // An unreadable candidate is UNDETERMINED, not "absent": it stays a
      // location to verify and gets named, so nobody reads "nothing to check"
      // out of a directory this could not open. It never reaches git — there is
      // nothing confirmed on disk to ask about.
      if (probe.fault !== undefined) {
        undetermined.push(`${rel}: ${probe.fault}`);
        found.push({
          dirRel,
          source: path.join(source, dep),
          status: "unreadable",
          fault: probe.fault,
        });
        continue;
      }
      if (!probe.nonEmpty) continue;
      const status = await ignoredStatus(execFn, repoRoot, rel);
      if (status === "git-error") {
        const detail = await gitProbeDetail(execFn, repoRoot, rel);
        undetermined.push(`${rel}: git could not determine ignore status${detail}`);
        // Kept in the expectation: a probe that failed is not a verdict that
        // the tree is untracked, and dropping it here is what made a broken
        // repo look like a repo with no dependencies to link.
        found.push({
          dirRel,
          source: path.join(source, dep),
          status,
          detail: detail || undefined,
        });
        continue;
      }
      if (status !== "ignored") continue;
      found.push({ dirRel, source: path.join(source, dep), status });
    }
  }
  return { locations: found, undetermined };
}

/**
 * Git's own words for a candidate `ignoredStatus` already reported as
 * `"git-error"` — `fatal: .git/index: index file smaller than expected` is the
 * whole diagnosis, and the verdict alone drops it.
 *
 * This re-runs the probe, which is the ONE exception to the one-probe-per-
 * candidate rule, and the exception is bounded: it runs only on a candidate
 * already classified `git-error`, whose verdict was produced by the single
 * `ignoredStatus` call above. Its answer never decides anything — a probe that
 * fails again here yields the empty string, and the verdict is already fixed —
 * so it cannot disagree with the caller the way the gate's old second executor
 * could.
 */
async function gitProbeDetail(execFn: ExecFn, repoRoot: string, rel: string): Promise<string> {
  try {
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      argv: ["check-ignore", "-q", "--", rel],
    });
    return "";
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
    const code = typeof e?.code === "number" ? `exit ${e.code}: ` : "";
    const text =
      typeof e?.stderr === "string" && e.stderr.trim() !== ""
        ? e.stderr.trim()
        : typeof e?.message === "string"
          ? e.message
          : String(err);
    return ` (${code}${text.slice(0, 160)})`;
  }
}

/**
 * Does ANY shareable-dep source exist at all — the precondition for the hook
 * path, and deliberately NOT a filtered version of `expectedDepLocations`.
 *
 * The one-line answer this gives: "the hook has something to link, or at least
 * something it might have been able to link." The `or at least` clause is the
 * whole reason this is a separate predicate rather than a flag on the other one
 * — the two questions differ, and conflating them (this function used to call
 * `expectedDepLocations` with no `execFn`) changed what a fault meant:
 *
 *   - here: "does the hook have anything to link?" An UNREADABLE candidate
 *     must count as "something might be there" — answering "nothing" is what
 *     made a fork-A "fresh clone, nothing to link" problem out of a directory
 *     that exists and is merely locked. That is the #1394 regression this
 *     replaces, and it is why a fault here is collected and OR-ed into the
 *     answer rather than thrown or ignored.
 *   - in `expectedDepLocations`: "must the worktree have this?" There an
 *     unreadable candidate must become a named problem.
 *
 * No `git check-ignore` probe either — and that is what "probe-free" names. At
 * this point the hook has not run, so whether the candidate is gitignored says
 * nothing about whether the hook has a source to work from; asking git would
 * also make an unreadable directory answer "no source exists" and print a
 * fresh-clone diagnosis for a repo whose tree is merely locked.
 *
 * `faults` is an out-parameter on purpose: the caller prints the sentences, and
 * the answer itself only needs the boolean. Callers that want the reasons named
 * in a `problem` pass an array; the shape mirrors `expectedDepLocations`'
 * `undetermined`.
 */
export async function anyLinkableSharedSource(
  repoRoot: string,
  packageDirs: string[],
  faults: string[],
): Promise<boolean> {
  const locations: Array<{ dirRel: string; source: string }> = [
    { dirRel: "", source: repoRoot },
    ...packageDirs.map((d) => ({ dirRel: d, source: path.join(repoRoot, d) })),
  ];
  let any = false;
  for (const dep of SHAREABLE_DEPS) {
    for (const { dirRel, source } of locations) {
      if (!candidatesForDir(dirRel).includes(dep)) continue;
      const probe = await probeNonEmptyDirectory(path.join(source, dep));
      if (probe.fault !== undefined) {
        faults.push(`${path.join(dirRel, dep)}: ${probe.fault}`);
        any = true;
      } else if (probe.nonEmpty) {
        any = true;
      }
    }
  }
  return any;
}

/**
 * #1146 — the expected dependency locations a worktree does NOT have: the
 * source is non-empty but the worktree path does not resolve to a non-empty
 * directory. The develop gate reads this before running the verify command,
 * so a bare worktree fails in seconds with the missing path named instead of
 * stalling until the verify timeout.
 *
 * #1394 — the ignore status is probed HERE, once per candidate, and returned
 * with each entry (`status`, the same `ignoredStatus` the provisioning path
 * uses). The gate used to re-probe every result in its own
 * `checkIgnoreStatus`, which meant two executors, two exit-code tables, and two
 * opinions about what an unknown verdict meant. Now the gate reads the verdict
 * this function already computed — and candidates whose probe could not run are
 * returned in `faults` so a gate that used to see "nothing missing" on a broken
 * repo sees the thing that stopped it from knowing.
 */
export interface MissingDep {
  rel: string;
  source: string;
  /** The probe that decides whether "missing" is a provisioning failure at all. */
  status: IgnoreVerdict | "unreadable";
  /** Set only when `status === "unreadable"` — the errno the probe never got past. */
  fault?: string;
  /**
   * Set only when `status === "git-error"` — git's own words, so the gate can
   * name a failure it has no other way of knowing. Carried through from
   * `DepLocation`; the gate renders it and decides nothing with it.
   */
  detail?: string;
}

export async function missingDepLocations(
  repoRoot: string,
  packageDirs: string[],
  worktreeAbs: string,
  execFn: ExecFn,
): Promise<{ missing: MissingDep[]; faults: string[] }> {
  const expected = await expectedDepLocations(repoRoot, packageDirs, execFn);
  const missing: MissingDep[] = [];
  for (const loc of expected.locations) {
    const rel = path.join(loc.dirRel, path.basename(loc.source));
    if (await resolvedNonEmptyDirectory(path.join(worktreeAbs, rel))) continue;
    missing.push({
      rel,
      source: loc.source,
      status: loc.status,
      fault: loc.fault,
      detail: loc.detail,
    });
  }
  return { missing, faults: expected.undetermined };
}

/**
 * True when the path exists, RESOLVES (a symlink to a since-deleted target
 * does not — `fs.realpath` throws and the check fails), and is a non-empty
 * directory. `dist/` build output is deliberately out of this check's scope:
 * it is on `NEVER_SHARED` and the hook builds it locally.
 *
 * Permissive by contract, and that is not an oversight: every caller of this
 * asks the question AFTER something was supposed to have created the link, so
 * "could not resolve" and "is not there" are the same actionable answer — a
 * `problem` naming the path. A fault is therefore absorbed, not thrown.
 * `resolvedNonEmptyWithFault` is the same probe for a caller that wants to
 * say WHY.
 */
export async function resolvedNonEmptyDirectory(abs: string): Promise<boolean> {
  return (await resolveNonEmpty(abs)).resolves;
}

/** `resolvedNonEmptyDirectory` plus the reason it failed, when there was one. */
export async function resolvedNonEmptyWithFault(
  abs: string,
): Promise<{ resolves: boolean; fault?: string }> {
  return resolveNonEmpty(abs);
}

async function resolveNonEmpty(abs: string): Promise<{ resolves: boolean; fault?: string }> {
  let resolved: string;
  try {
    resolved = await fs.realpath(abs);
  } catch (err) {
    // ENOENT — nothing was ever created there, the ordinary no-op-hook answer.
    // Anything else (a symlink chain, a directory this cannot traverse) is a
    // fault worth naming, but still not worth throwing for.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { resolves: false };
    return { resolves: false, fault: errnoDetail(err) };
  }
  const probe = await probeNonEmptyDirectory(resolved);
  return probe.nonEmpty ? { resolves: true } : { resolves: false, fault: probe.fault };
}
