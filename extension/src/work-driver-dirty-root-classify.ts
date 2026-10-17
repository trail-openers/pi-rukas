/**
 * work-driver-dirty-root-classify — #1421: splitting "repoRoot is dirty" into
 * the two questions that gate has always conflated.
 *
 * The consolidated verify's preflight refuses to consolidate whenever
 * `git status --porcelain` reports anything outside the driver-managed and
 * configured-exempt prefixes, and the cycle then parks as
 * `verify-failed:develop` — the cap pi-rukas reserves for a gate that judged
 * the code. Live cycle cycle-id (example-owner/orchard#248) parked a complete,
 * reviewed, 3-commits-ahead change on five paths:
 *
 *   target/.rustc_info.json, target/CACHEDIR.TAG, target/debug/.cargo-*-lock
 *
 * — cargo's own build output and lock files, produced by the driver's OWN
 * root-level gate run (`bash scripts/verify.sh` builds at the repo root), and
 * unignored only because the base commit's `.gitignore` lists `/console/target/`
 * and not `/target/`. The change whose whole point was the root build was
 * refused verification by residue its own earlier consolidation left behind.
 *
 * The refusal was correct about ONE thing and wrong about the other:
 *
 *   - **Dirt** — a tracked modification, a staged entry, a rename, an
 *     unignored untracked file. The consolidation's checkout would carry it
 *     onto the probe branch, or the staging read would sweep it into the
 *     branch. The gate MUST refuse.
 *   - **Build residue** — an untracked path git itself declares ignored
 *     (`.gitignore`, `core.excludesFile`, `.git/info/exclude`), or one the
 *     driver wrote. It is not content a checkout can move and `git add .`
 *     cannot sweep; it is a tool's output sitting in the working tree. It must
 *     not read as a code failure.
 *
 * So this module answers the second question from git's own opinion, and the
 * caller decides what to do about it: residue no longer refuses the gate; the
 * cap distinguishes an environment refusal from a code verdict.
 *
 * Why `git status --ignored=matching --porcelain -uall` is the only safe
 * source for the ignored list:
 *
 *   - `git check-ignore <path>` is wrong in both directions without
 *     `--no-index`: it reports a TRACKED path that matches a gitignore pattern
 *     as ignored, and the gate is deciding whether that path may hide uncommitted
 *     source. Its exit codes (0/1/≥2) also collapse into one state in most
 *     callers, so "git itself failed" reads as "not ignored" — the #481 defect
 *     shape, repeated per path, per cycle.
 *   - Matching `.gitignore` by hand would be a second implementation of git's
 *     pattern language (negation, directory-only patterns, anchoring,
 *     `core.excludesFile`, `.git/info/exclude`) that drifts from the first.
 *   - `--ignored=matching` reports ignored files without walking every
 *     directory of an ignored tree, and marks directories with a trailing `/`.
 *
 * An unreadable listing read returns `undefined`, and the caller then treats
 * EVERY path as dirt — the fail-closed direction and the pre-#1421 behaviour.
 * `git check-ignore` (see `probeIgnored`) is the exact per-path question that
 * does not need this listing at all: with `-uall`, git still COLLAPSES a
 * wholly-ignored directory to one `!! target/` entry and never prints the
 * files inside it, which is precisely the residue the incident charged as
 * dirt. `classifyRootDirt` consults both, and needs BOTH to have answered
 * before it exempts anything.
 */

import { traceWarn } from "./trace.ts";
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import { isConfiguredExemptDirtLine, normaliseRepoPath } from "./work-driver-dirty-root-exempt.ts";
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
 * Why a repoRoot dirt line is not this cycle's problem. One reason per line,
 * carried into the handoff so the operator learns WHY the gate stopped
 * refusing — an unexplained pass is as useless as an unexplained refusal.
 */
export type DirtReason = "git-ignored" | "driver-artefact";

/** The classification of one repoRoot dirt line. */
export interface RootDirtClass {
  /** Lines the dirty-root gate still refuses on. */
  dirt: string[];
  /** Lines reclassified as residue, with their reason. */
  residue: { line: string; reason: DirtReason }[];
  /**
   * True when the gate considered NOTHING but residue: every line it looked
   * at (after the driver-managed / configured-exempt drops) was reclassified.
   *
   * The caller needs this distinction because the two shapes mean different
   * things. "Only residue" is an environment refusal — the gate declined a
   * root that held a tool's output and nothing else. "Residue beside dirt the
   * exemptions dropped" is NOT: the exemption is what unblocked the run, the
   * residue is incidental, and the pre-#1421 behaviour (run the verify) is the
   * honest one. Deriving it from a substring of the failure prose would let an
   * operator-authored path containing the tag decide the cap.
   */
  buildResidueOnly?: boolean;
}

/**
 * The driver's own scratch prefixes, kept narrow on purpose.
 *
 * `isDriverManagedDirtLine` exempts `.worktrees/`, `.pi/` and `tmp/` wholesale
 * for ANY porcelain code, because those gates ask "did a previous cycle leave
 * scratch here?". This classifier asks a different question — "is this path
 * this cycle's work?" — and a wholesale `tmp/` prefix would exempt a
 * `?? tmp/evil.ts` that changes what the verify command reads. So only the
 * paths the DRIVER itself writes are its own. Same narrowing `work-driver-verify-tree.ts`
 * applies for tree identity; a third widening would be the inconsistency.
 */
const DRIVER_SCRATCH_RE = /^tmp\/issue-\d+(\/|$)/;
const DRIVER_WORKTREE_RE = /^\.worktrees(\/|$)/;
const DRIVER_STATE_RE = /^\.pi\/work-state(\/|$)/;

/** Which reason (if any) makes this untracked path the driver's own doing. */
function driverArtefactReason(rawPath: string): DirtReason | undefined {
  const p = normaliseRepoPath(rawPath);
  if (DRIVER_SCRATCH_RE.test(p) || DRIVER_WORKTREE_RE.test(p) || DRIVER_STATE_RE.test(p))
    return "driver-artefact";
  return undefined;
}

/**
 * The untracked paths git itself declares ignored, normalised for comparison.
 *
 * Two forms, because the status output cannot answer the whole question. With
 * `-uall`, git lists ignored FILES under a tracked directory (`!! build/out.js`)
 * but collapses a wholly-ignored directory to `!! target/` — so a gate reading
 * only that output would classify `?? target/.cargo-lock` as dirt and refuse,
 * which is the incident. Hence the prefix set plus a direct probe per candidate
 * path, which is exact and independent of how git chose to print the tree.
 *
 * Both sources come from `git status`, so `.gitignore`, `core.excludesFile`
 * and `.git/info/exclude` all count, and neither reimplements git's pattern
 * language. `--ignored=matching` keeps git from walking every directory of an
 * ignored tree.
 *
 * Returns `undefined` when the read failed — the caller treats that as "I
 * cannot tell", never as "nothing is ignored".
 */
export async function readIgnoredPaths(
  execFn: ExecFn,
  repoRoot: string,
): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFn("git status --ignored=matching --porcelain -uall", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
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
  } catch {
    return undefined;
  }
}

/**
 * One untracked path, judged against the ignored set: itself or any ancestor
 * prefix. `git status` may have reported the ancestor (`!! target/`) rather
 * than the file, so the ancestor check is what makes a `target/.cargo-lock`
 * match the `target` entry the collapsed listing produced.
 */
function isUnderIgnored(path: string, ignored: Set<string>): boolean {
  if (ignored.size === 0) return false;
  const segments = path.split("/");
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    if (ignored.has(prefix) || ignored.has(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * The dirty-root gate's own filter: the driver-managed prefixes, the
 * project's configured exemptions, and blank lines all drop out. Shared by
 * every gate that reads repoRoot's status, so a line this module classifies is
 * the same line `readRepoRootDirt` would have refused on.
 */
export function isGateDirtLine(line: string, exempt?: readonly string[]): boolean {
  return (
    line.trim().length > 0 &&
    !isDriverManagedDirtLine(line) &&
    !isConfiguredExemptDirtLine(line, exempt)
  );
}

/** Is this porcelain line git's own declaration of an ignored path (`!!`)? */
function isIgnoredPorcelainLine(line: string): boolean {
  return line.trimStart().startsWith("!!");
}

/** Is this porcelain line an untracked entry (`??`)? */
function isUntrackedLine(line: string): boolean {
  return line.trimStart().startsWith("??");
}

/**
 * Split repoRoot's dirt lines into what the gate must refuse on and what is
 * residue. Takes the lines, not the status output: each caller already reads
 * git status for its own purposes (`-uall` here, plain `--porcelain` at
 * handoff consolidation) and the classification must not depend on which.
 *
 * Only UNTRACKED (`??`) lines can be residue. A tracked modification, a staged
 * entry, a deletion or a rename is dirt whatever `.gitignore` says about the
 * path — a file that became ignored after it was tracked still holds
 * uncommitted source, and exempting it would hide exactly the work the gate
 * exists to protect.
 *
 * `ignored === undefined` (the read failed) classifies every line as dirt:
 * the fail-closed direction, and the pre-#1421 behaviour. `probed` is NOT a
 * way around it — a direct `check-ignore` hit exempts a path only when the
 * listing read also answered. If it did not, one path matching a pattern the
 * listing never got to report is not evidence the whole root is a tool's
 * output, and the pre-#1421 refusal stands.
 *
 * `probed` carries the direct answer to "is this exact path ignored?" for
 * paths the status listing collapsed: git prints `!! target/` for a wholly
 * ignored directory, so a `?? target/.cargo-lock` matches nothing in the
 * listing and would otherwise stay in `dirt` — the refusal this issue is about.
 *
 * A line git itself printed as ignored (`!! …`) is never dirt, whatever the
 * porcelain code's first column says: it is git declaring the path its own
 * output, which is exactly the residue case. It lands in `residue` under
 * `git-ignored`, so a caller that hands this function a mixed listing cannot
 * have an ignored artifact charged as dirt.
 *
 * `buildResidueOnly` is the caller's routing key and it is deliberately
 * stricter than "`dirt` is empty": it is true only when every path the gate
 * was deciding is residue. Lines the dirty-root gate drops wholesale — the
 * driver-managed prefixes (`.worktrees/`, `.pi/`, `tmp/`) and a project's
 * configured exemptions — are never judged at all, so they neither count
 * toward it nor block it. A tracked modification, staged entry, deletion or
 * rename is dirt the porcelain code decided, and it rules the decline out.
 * So a root whose only other content was an exempted tool file runs the
 * verify instead of declining — the exemption (#1362) is what unblocked it,
 * and crediting the residue for that pass would be the wrong story — while
 * the decline stays reserved for the root that holds nothing but a tool's
 * output. A `!!` line git itself printed is residue and counts as such: its
 * own status is the answer.
 */
export function classifyRootDirt(
  lines: readonly string[],
  ignored: Set<string> | undefined,
  exempt?: readonly string[],
  probed?: ReadonlySet<string>,
): RootDirtClass {
  const considered: string[] = [];
  const residue: { line: string; reason: DirtReason }[] = [];
  // #1421 fix round (item 6) — what entitles the gate to say "this root held
  // nothing but build output". The claim is about what the gate had to refuse
  // on, so the veto population is the lines that are NOT dirt and NOT residue:
  //
  //   - a TRACKED entry (" M ", "R ", "D ") — dirt the porcelain code judged.
  //     It stays in `dirt` AND vetoes: a root the gate would have refused is
  //     never one that "declined on residue";
  //   - an untracked line the ignored read could not account for — dirt by the
  //     fail-closed rule, and it already shows up in `dirt`.
  //
  // Lines the gate DROPS are not vetoes, and that is the distinction #1421's
  // fix round turns on: an untracked path the PROJECT exempted (#1362) is not
  // something the gate refuses on either, so its presence does not make "the
  // residue is the only thing here" false — it makes the exemption the reason
  // the root is clean, which is why the caller falls through and RUNS the
  // verify (pinned end-to-end in the consolidated-verify tests) rather than
  // claiming a decline. A decline is reserved for a root that has nothing but
  // residue and the driver's own scaffolding to begin with.
  const untracked: string[] = [];
  const vetoLines: string[] = [];
  for (const line of lines) {
    if (!isGateDirtLine(line, exempt)) continue; // blank, driver's own, or exempted
    const untrackedLine = isUntrackedLine(line);
    const ignoredLine = isIgnoredPorcelainLine(line);
    if (!untrackedLine && !ignoredLine) {
      // Tracked dirt — dirt by the porcelain code, not by the ignored set.
      considered.push(line);
      vetoLines.push(line);
      continue;
    }
    considered.push(line);
    if (ignoredLine) {
      // `!!` — git already answered the question this function exists to ask,
      // so the line is residue regardless of what the probe or listing says.
      residue.push({ line, reason: "git-ignored" });
      untracked.push(line);
      continue;
    }
    const path = normaliseRepoPath(line.slice(2));
    // The driver's own artefact: residue by its OWN reason, decided before the
    // ignore question so git's opinion about a driver path cannot relabel it.
    const driverOwn = driverArtefactReason(path);
    if (driverOwn !== undefined) {
      residue.push({ line, reason: driverOwn });
      continue;
    }
    untracked.push(line);
    // An unreadable ignored list answers nothing: every untracked line stays
    // dirt. That is the fail-closed direction and the pre-#1421 behaviour.
    if (ignored === undefined) continue;
    if (isUnderIgnored(path, ignored) || probed?.has(path)) {
      residue.push({ line, reason: "git-ignored" });
    }
  }
  const dirt = considered.filter((l) => !residue.some((r) => r.line === l));
  return {
    dirt,
    residue,
    // The decline needs at least one residue, nothing the gate refused on, and
    // every untracked line it judged accounted for as residue.
    ...(vetoLines.length === 0 &&
    residue.length > 0 &&
    untracked.every((l) => residue.some((r) => r.line === l))
      ? { buildResidueOnly: true }
      : {}),
  };
}

/**
 * Which of these untracked paths git declares ignored, asked directly
 * (`git check-ignore --no-index -z --stdin`) rather than inferred from the
 * status listing, which collapses wholly-ignored directories.
 *
 * ONE git call per probe, in the argv form: a shell string that merely
 * contains the word `git` is indistinguishable from a verify command to an
 * `ExecFn` that counts them separately, and a piped form here was counted as a
 * second verify run and silenced a flake-recovery test.
 *
 * Returns `undefined` when git could not answer, and the caller then fails
 * closed. Three states, exactly as `checkIgnoreStatus` in
 * work-driver-deps-gate.ts reads them:
 *
 *   - exit 0 — the batch printed the ignored subset;
 *   - exit 1 — git ANSWERED: nothing in the batch is ignored. That is a real
 *     empty set, not a failure, and conflating the two is what made a clean
 *     tree indistinguishable from a broken git;
 *   - anything else (exit ≥ 2, a spawn failure, a kill, a rejection that
 *     reports no code at all) — git could not answer. The set is `undefined`, the reason is traced, and a caller that
 *     cannot tell must charge every path as dirt.
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
  try {
    // `git check-ignore` reads one path per line from --stdin; passing the
    // batch as trailing pathspec arguments is equivalent, needs no shell, and
    // keeps the call a single argv-form git invocation. Paths come from git's
    // own status output, so they are relative and cannot be options; `--` is
    // the guard that keeps a path beginning with a dash a path.
    const { stdout } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
      argv: ["check-ignore", "--no-index", "--", ...candidates],
    });
    for (const line of stdout.split("\n")) {
      const norm = normaliseRepoPath(line);
      if (norm.length > 0) out.add(norm);
    }
    return out;
  } catch (err) {
    const e = err as Error & { killed?: boolean };
    const code = exitCodeOf(err);
    // Exit 1 is git's answer, not git's failure: "none of these are ignored".
    // The empty set is then correct information, and the caller keeps its
    // fail-closed dirt list on the strength of the read, not a guess.
    if (code === 1 && e.killed !== true) return out;
    const how = typeof code === "number" ? `exit ${code}` : e.killed === true ? "killed" : "error";
    const detail = e.message ?? String(err);
    // Loud, not debug-gated: this is the state where the driver's answer to
    // "is that path git's own output?" is unknowable, and the cycle's outcome
    // turns on it — the caller charges every untracked path as dirt, so a
    // finished change can park on a git that would not answer. Silence here
    // is the #481 defect shape.
    traceWarn(
      `work-driver: probeIgnored could not ask git (${how}${typeof code === "undefined" ? ", no exit code reported" : ""}): ${detail.slice(0, 200)} — the ignored set is unknown, so every untracked path is charged as dirt (fail closed)`,
    );
    return undefined;
  }
}

/**
 * The path a residue porcelain line names, stripped for display: git's quoting
 * and the square brackets a rename or a quote can carry into the text are
 * removed, so a path is never re-emitted inside the labelled failure string
 * with bracket characters that a later `[label]` matcher could mistake for one
 * of the routing tags (#1421 fix round).
 */
export function residuePathText(line: string): string {
  return normaliseRepoPath(line.slice(2))
    .replace(/[\[\]]/g, "")
    .trim();
}

/**
 * Does this recorded failure string describe build residue the gate declined
 * to refuse on? The label is the cap router's key, exactly as
 * `[host-resource-exhaustion]` and `[verify-timeout]` are.
 */
export const BUILD_RESIDUE_LABEL = "[build-residue]";

export function isBuildResidueFailure(failure: string): boolean {
  return failure.includes(BUILD_RESIDUE_LABEL);
}

/**
 * The failure string for a consolidated gate that reached no verdict because
 * build output sat in the root it was about to mutate.
 *
 * It names WHERE the paths came from, because that is what the incident's
 * record did not: "leftover residue from an earlier cycle" was a guess, and
 * the residue was the driver's own verify run. The source is stated as
 * "untracked and git-ignored", which is what the classifier actually proved.
 */
export function buildResidueFailure(paths: readonly string[], where: string): string {
  const named = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? ` (+${paths.length - 5} more)` : "";
  return `${BUILD_RESIDUE_LABEL} ${where} — ${paths.length} untracked, git-ignored build artifact(s) in the root the gate would have mutated: ${named}${more}. These are build output, not source: git itself declares them ignored, nothing was judged, and the change is neither confirmed nor refuted. The consolidated verify ran despite them; to keep the root clean, point the project's build at a directory outside the checkout (e.g. CARGO_TARGET_DIR) or gitignore the output where it lands.`;
}
