/**
 * write-fence-deletion — the `tool_call` hook that keeps a child's DELETIONS
 * inside its own trees (#2200).
 *
 * The field evidence: a /work develop child hit a disk-quota error in the shared
 * temp root and cleared it itself — about fifty commands, `rm -rf` and `rmdir` on
 * literal paths, a `find … -print0 | xargs -0 -r rm -rf` sweep across thirty name
 * prefixes (other projects' temp dirs, test-runner dirs, other cycles' live
 * reviewer trees), and an `rm -rf` of a VCS root the operator kept under that
 * root. About 9.8 GB went. The write fence refused only the glob and
 * unresolvable-expansion forms: every LITERAL `rm -rf` outside the child's
 * worktree went through, because the write rule lets anything land under the OS
 * temp dirs (a build must be able to write there), and an interpreter one-liner
 * was not read at all.
 *
 * So the deletion rule is a second one, with a different allowance, registered
 * beside the fence but NOT gated on it:
 *
 *   - the allowed roots are the worktree, the cycle scratch dir and the child's
 *     OWN per-child temp root — never the shared temp root, whatever its name.
 *     They come from the raw env, never from `loadFenceConfig`: that returns
 *     undefined for exactly the reviewer (no `PI_ENSEMBLE_WRITE_ROOT`) and the
 *     `PI_ENSEMBLE_WRITE_FENCE=0` cases this hook must still refuse.
 *   - it has no opt-out. The hatch is the developer whole-tree fence's switch and
 *     reaches writes only; an operator who needs a deletion outside the roots runs
 *     it from the parent session, which this child-only hook does not cover.
 *   - what cannot be resolved at a delete position is refused, in the bash fence's
 *     own fail-closed vocabulary rather than a second invented verdict.
 *
 * Reading the command is the reader's job (write-fence-deletion-positions.ts):
 * the bash walk, the operand table and the interpreter reader, with the rule that
 * a word counts as a deleted path only when a command this rule owns named it.
 * This module is the judgement and the record: resolve each position, compare it
 * with the child's roots, refuse the first one that lies outside them.
 *
 * `git clean` is the one overlap. The destructive-git guard owns it and has its own
 * opt-out; a forcing clean (`-f`/`--force`, never `-n`) aimed OUTSIDE the child's
 * roots is refused here whatever that opt-out says, because that opt-out is about
 * the child's own working tree. Aimed inside, nothing here refuses it, so the
 * guard's rule and its hatch stay the only answer for the in-tree case and that
 * guard's test rows stay green. No `git clean` verb is added to the writers table.
 *
 * The refusal names the rule and the allowed roots and NEVER the target — a target
 * is an operator path and the handoff is public. Like the dependency rule (#1879)
 * this is a guardrail against an agent's own bad judgement, not a security
 * boundary: a command that names no path this scanner reads stays outside it, and
 * the categories it does not reach are listed in docs/troubleshooting.md.
 */

import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";
import { deletePositions } from "./write-fence-deletion-positions.ts";
import {
  NOT_JUDGED_LOG_TOKEN,
  OUTSIDE_REASON,
  UNRESOLVED_REASON,
} from "./write-fence-deletion-tokens.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import { homeDir, isInside, safeResolve } from "./write-fence-path.ts";

export {
  DELETION_LOG_TOKEN,
  GIT_CLEAN_LOG_TOKEN,
  NOT_JUDGED_LOG_TOKEN,
  OUTSIDE_REASON,
} from "./write-fence-deletion-tokens.ts";

/** What the hook may delete into, as the child's env named it. */
export interface DeletionRoots {
  /** The child's working directory: the base for a target the command left relative. */
  cwd: string;
  /** The worktree, scratch dir and per-child temp root, exactly as the env named them. */
  labels: string[];
  /** The same roots as realpaths; an unusable one is absent, never guessed at. */
  allowed: string[];
}

/** A refused delete position: the log's `path` token, and the reason clause. */
export interface DeletionHit {
  token: string;
  reason: string;
}

/** Resolve a target and judge it against the allowed roots; undefined when it lies inside one. */
function judge(abs: string, roots: DeletionRoots, token: string): DeletionHit | undefined {
  const real = safeResolve(abs);
  if (real === undefined) return { token, reason: UNRESOLVED_REASON };
  if (roots.allowed.some((allowed) => isInside(real, allowed))) return undefined;
  return { token, reason: OUTSIDE_REASON };
}

/**
 * The first delete position this child may not take, or undefined when every one
 * lies inside its roots.
 */
export function firstDeletionOutside(
  command: string,
  roots: DeletionRoots,
): DeletionHit | undefined {
  for (const hit of deletePositions(command, roots.cwd)) {
    if (hit.reason !== "") return { token: hit.token, reason: hit.reason };
    const judged = judge(hit.path ?? "", roots, hit.token);
    if (judged !== undefined) return judged;
  }
  return undefined;
}

/** The per-child temp root the spawn layer names for one child (#2200), as
 * `writeRolePromptFile` creates it. Read as a NAME and not as a property, so the
 * env inventory in headless/inputs.ts stays the single list of what the build honours. */
export const CHILD_TMP_ENV = "PI_ENSEMBLE_CHILD_TMP";

/**
 * The one role this rule does not judge. The issue scopes the rule to a child the
 * driver gave trees to — "a develop or lens-fix child's deletes … are refused outside
 * its worktree and its own scratch dir" — and keeps the operator's own commands out of
 * it ("Operator (parent session) commands", Out of scope). An `ops` dispatch is neither:
 * the driver never fences it, so it has no worktree, no scratch and no reason of its own
 * to delete, yet it is the role that works in the operator's checkout and clears build
 * and dependency trees there as its job. Refusing it everything would turn a git/gh
 * dispatcher into a role that cannot `rm -rf node_modules` where it stands, which is not
 * what the incident was about. Its OWN cwd is therefore a working root for this rule
 * only; every other tree, the shared temp root above all, stays refused — and the cwd is
 * admitted as a root only while it is a working tree, never while it *is* (or holds) a temp
 * root, the home directory, or the filesystem root (see `usableWorkingDirectory`).
 */
const UNSCOPED_ROLE = "ops";

/** Whether this child's role is the one the rule leaves alone inside its own cwd. */
function isUnscopedRole(role: string | undefined): boolean {
  return role === UNSCOPED_ROLE;
}

/** One usable absolute root from the env, as the label it was named by and its realpath. */
function usableRoot(raw: string | undefined): { label: string; real: string } | undefined {
  if (raw === undefined || raw === "" || !path.isAbsolute(raw)) return undefined;
  try {
    if (!statSync(raw).isDirectory()) return undefined;
  } catch {
    // Any stat failure (ENOENT, EACCES on a parent) means the root is not usable.
    return undefined;
  }
  const real = safeResolve(raw);
  return real === undefined ? undefined : { label: raw, real };
}

/** Whether this resolved path exists as a directory, as `statSync` reports it. */
function isDirectory(raw: string): boolean {
  try {
    return statSync(raw).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The roots an `ops` cwd is never allowed to stand for: the well-known temp dirs, `$HOME`, and
 * the filesystem root. The driver dispatches `ops` at the checkout (`roles.ts` gives it
 * `cwd: "repo"`), so a cwd that resolved to one of these is a spawn that pointed the role at a
 * shared tree — and the rule exists precisely to keep a child out of the shared temp root,
 * which the incident cleared. Refusing the cwd as a root there costs an `ops` child nothing it
 * needs (its work is in the checkout) and closes the one shape where the carve-out covered the
 * incident's own damage.
 *
 * The set is a FIXED canonical union compared on resolved paths, and nothing is dropped for
 * being absent: `TMPDIR` from the env this call was handed AND from the well-known spellings, and
 * the home directory read BOTH ways — `$HOME`, which is what the shell expands `~` to, and the OS
 * passwd entry. A redirected `TMPDIR` (a test env, or a spawn that pointed the role at a tree of
 * the child's choosing) only ever ADDS a root; it never removes one.
 *
 * The temp roots and BOTH home reads come from the one `env` the dispatch handed over, never from
 * `process.env` behind the caller's back. Splitting them — the caller's `HOME` against the
 * harness's `TMPDIR` — makes the two disagree, and on a host whose temp dir sits under `$HOME`
 * (what macOS publishes, and any operator who parks their scratch at `~/tmp`) every working tree
 * then looks like it lies inside a temp root, so the `ops` carve-out closes on the checkout the
 * driver actually dispatches the role into.
 *
 * A temp root is refused for its whole subtree, not just its own directory: the rule resolves a
 * path before it judges it, so a child standing in `/tmp/<other run>` could reach the shared
 * root itself with `rm -rf ..` and clear every other project's temp dir — the incident's damage,
 * arrived at one level deeper. `$HOME` is refused only as itself, and so is any ancestor of a
 * redirected `TMPDIR`: treating either as a whole-subtree refusal would refuse every cwd on the
 * volume, including the checkout the driver actually dispatches `ops` into, because both hold
 * every path a legitimate working tree can live under. The parent of the MACHINE's own temp
 * root is the one exception — it holds nothing but per-run scratch, so a child standing in it
 * reaches every sibling run's temp dir and has no working business there. "The machine's own"
 * means the temp root the PROCESS was started with — `os.tmpdir()`, the one value the spawn layer
 * mkdtemp's per-child dirs under: a `TMPDIR` naming some other tree is a redirect and gets that
 * tree refused, never its parent — otherwise a redirected `TMPDIR` under a scratch tree that also
 * holds a checkout closes the carve-out on that checkout for the whole subtree of the tree
 * holding it.
 */
function forbiddenWorkingDirectories(
  env: NodeJS.ProcessEnv,
): { real: string; wholeSubtree: boolean }[] {
  // The roots refused for their WHOLE SUBTREE: every temp root this call sees, plus the parent of
  // the one tree the machine really keeps its scratch in. A child standing in any of them reaches
  // the shared root itself — or a SIBLING child's temp dir — with `rm -rf ..`, so a subtree
  // refusal on the parent is the same refusal one level up.
  const shared = new Set<string>();
  const seed = new Set<string>();
  const addTemp = (raw: string | undefined, seeds: boolean): void => {
    if (raw === undefined || raw === "" || !path.isAbsolute(raw)) return;
    const real = safeResolve(raw);
    if (real === undefined || !isDirectory(real)) return;
    shared.add(real);
    if (seeds) seed.add(real);
  };
  // Each temp root is refused for its OWN subtree, named by its own source: the well-known
  // spellings, this env's `TMPDIR`, and the temp root the process was started with.
  for (const dir of tempSpellingValues(env)) addTemp(dir, false);
  // The process's own temp root is the ONLY thing the ancestor walk climbs from. It is what the
  // spawn layer's `os.tmpdir()` returns and where it mkdtemp's each child's per-child dir
  // (`spawn-support.ts`, `mkdtemp(os.tmpdir() + "/pi-rukas-")`), so its parent is the tree that
  // really holds every per-run scratch directory — the place a child standing in it reaches a
  // sibling run's temp dir from. Nothing else is anyone's per-run scratch, so nothing else is
  // climbed: not the well-known `/tmp`, `/var/tmp`, `/private/tmp` (whose parents are `/`, `/var`
  // and `/private`, and refusing `/var` for its subtree would close the carve-out on a checkout
  // parked under it — the same whole-volume error the `$HOME` rule below settles; they are refused
  // as themselves, and only their subtree stays open to a working directory), and not this env's
  // `TMPDIR` when it names a REDIRECT: a test env, or a spawn that aimed the role at a tree of the
  // child's choosing. A redirect's parent is an ordinary directory that legitimately holds
  // checkouts (`<scratch>/projects/repo` beside `<scratch>/machinetmp`), and closing its subtree
  // silently takes the `ops` carve-out off every checkout under it.
  addTemp(os.tmpdir(), true);
  addTemp(env.TMPDIR, false);
  // A directory NAMED for a temp root is a temp root by the only convention a child can be told
  // to aim at (`mktemp -p ./tmp`, `TMPDIR=$PWD/tmp`), so it is refused wherever it sits, not
  // merely where the machine keeps its own. The name is what a child's command can be read for;
  // no checkout, worktree or operator home carries one.
  //
  // The walk climbs the PARENT of the process's temp tree, and stops: the tree `mkdtemp` hands
  // every child's per-child temp dir to holds all of them, so a child standing in its parent
  // reaches a SIBLING's temp dir with `rm -rf ..`. It climbs no further and is seeded from no
  // other root. The parent is refused only where the machine's own temp dirs sit there — asked
  // of `TMPDIR`/`os.tmpdir()` alone, never of a redirected `TMPDIR`'s ancestry: on a test
  // harness (or any `TMPDIR` inside a checkout) the parent is the repo's own parent, and
  // refusing it for its subtree would close the carve-out on every tree in the repo. Where the
  // parent is the filesystem root the `$HOME`/`/` refusal below already covers it — and where it
  // is a HOME directory it is refused there as ITSELF, never by this walk, because on a host
  // whose temp dir is home-relative (macOS's `$TMPDIR`, an operator's `~/tmp`) the parent IS the
  // home directory, and closing its subtree would refuse the very checkouts the carve-out opens
  // for `ops`. A home directory is refused where it stands, not for everything under it.
  const holdsTempRoot = (candidate: string): boolean =>
    [...shared].some((t) => t !== candidate && isInside(t, candidate));
  // The two ancestors the walk may NEVER add, read from the same env as everything else here:
  // the filesystem root and EITHER home read. A temp root is refused for its whole subtree, so
  // adding either would refuse every working tree on the volume — which is exactly what happens
  // on a host that publishes a home-relative temp dir (macOS's `$TMPDIR`, an operator's `~/tmp`),
  // where the parent of the temp root IS the home directory and every checkout under it loses the
  // `ops` carve-out. The refusal of both as THEMSELVES (below) is what they get.
  const volumeRoots = new Set([path.sep, safeResolve(homeDir(env)), safeResolve(os.homedir())]);
  for (const real of seed) {
    const parent = path.dirname(real);
    if (parent === path.sep || shared.has(parent) || volumeRoots.has(parent)) continue;
    if (!holdsTempRoot(parent)) continue;
    addTemp(parent, false);
  }
  // The roots refused as THEMSELVES: `/`, the home directory the shell expands `~` to, and the
  // OS passwd entry. Containment is never the test for these — every path on the volume lies
  // under both, so a whole-subtree refusal there is a refusal of every cwd, including the
  // checkout the driver really dispatches `ops` into. A child standing IN either and deleting by
  // a relative path reaches the tree the rule exists for, which is why neither is a working
  // directory. Read from the env AND the passwd entry, so an env that carries neither `HOME` nor
  // `TMPDIR` cannot shrink the guard below what the machine actually has.
  const own = new Set<string>();
  for (const dir of [homeDir(env), os.homedir(), path.sep]) {
    if (dir === undefined || dir === "" || !path.isAbsolute(dir)) continue;
    // A home directory that does not exist is still refused as itself: an env that points `HOME`
    // at a tree of the child's choosing cannot open the carve-out through a home directory that
    // was never created.
    const real = safeResolve(dir);
    if (real !== undefined) own.add(real);
  }
  const out: { real: string; wholeSubtree: boolean }[] = [];
  for (const real of shared) out.push({ real, wholeSubtree: true });
  for (const real of own) {
    if (shared.has(real)) continue;
    out.push({ real, wholeSubtree: false });
  }
  return out;
}

/**
 * The basenames a temp root goes by — the fixed well-known spellings plus whatever this env's
 * `TMPDIR` is called. A scratch tree names its shared root one of these, and the name is the only
 * thing a child's command can be read for; no checkout, worktree or operator home shares one of
 * them. Read at the call, not once at load: a module-level constant would freeze the name the test
 * harness's redirected `TMPDIR` happened to have, and a scratch tree named for it would then
 * borrow the refusal.
 */
function tempDirectoryNames(env: NodeJS.ProcessEnv): Set<string> {
  return new Set<string>(
    [...TEMP_DIRECTORY_SPELLINGS, env.TMPDIR]
      .filter((d): d is string => d !== undefined && d !== "" && path.isAbsolute(d))
      .map((d) => path.basename(path.resolve(d)))
      .filter((n) => n !== "" && n !== path.sep),
  );
}

/** The temp roots every machine has, whatever its env says. */
const TEMP_DIRECTORY_SPELLINGS = ["/tmp", "/var/tmp", "/private/tmp"] as const;

/**
 * The temp roots as this call sees them: the spellings every machine has, plus this env's
 * `TMPDIR`.
 *
 * `os.tmpdir()` is deliberately NOT one of them — it caches its first answer for the life of the
 * process, so a test (or a spawn layer) that redirects `TMPDIR` partway through would keep being
 * judged against the dir it used before. The env spelling is the one that names where the child's
 * per-child temp root really lives: the spawn layer mkdtemp's it under `TMPDIR`, and it hands the
 * child that same `TMPDIR` in its env, so this is the value that agrees with the `$HOME` read
 * below rather than disagreeing with it.
 */
function tempSpellingValues(env: NodeJS.ProcessEnv): string[] {
  return [...TEMP_DIRECTORY_SPELLINGS, env.TMPDIR].filter(
    (d): d is string => d !== undefined && d !== "" && path.isAbsolute(d),
  );
}

/** The lexical and resolved spellings of one path, which is how a cwd is compared. */
function spellingsOf(raw: string): string[] {
  const resolved = safeResolve(raw);
  return resolved === undefined ? [path.resolve(raw)] : [resolved, path.resolve(raw)];
}

/**
 * The `ops` role's cwd as a working root, or undefined when it stands for a shared tree.
 * A cwd that is the filesystem root or `$HOME`, or that lies inside a temp root, is refused
 * as a root rather than admitted: `rm -rf .` there would delete the tree the rule was
 * written to protect, and the role has no business standing in it. The temp roots and both home
 * reads come from the ONE `env` the dispatch handed over: mixing the caller's `HOME` with the
 * harness's `TMPDIR` would refuse a real checkout whenever the machine keeps its temp dir under
 * the home directory.
 */
function usableWorkingDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv,
): { label: string; real: string } | undefined {
  const root = usableRoot(cwd);
  if (root === undefined) return undefined;
  const spellings = spellingsOf(cwd);
  // Refused as a working root when it IS one of the shared roots, or lies inside one. Every
  // comparison is made on BOTH spellings of the cwd — the path the dispatch handed over and
  // its resolved form — because a scratch tree stands exactly where `~` expands, and a fixture
  // `$HOME` is the very tree its own rows are written under: judging one spelling alone lets
  // the env open the carve-out for the tree the rule exists to protect, or close it for a
  // checkout the driver really dispatches the role into.
  const homeSpellings = [safeResolve(homeDir(env)), safeResolve(os.homedir())];
  const volumeRoots = [path.sep, ...homeSpellings].filter((s): s is string => s !== undefined);
  const forbidden = forbiddenWorkingDirectories(env);
  const refused = forbidden.some((f) =>
    spellings.some(
      (candidate) => f.real === candidate || (f.wholeSubtree && isInside(candidate, f.real)),
    ),
  );
  const isVolumeRoot = spellings.some((s) => volumeRoots.includes(s));
  const tempNames = tempDirectoryNames(env);
  // A directory NAMED for a temp root (`tmp`, or whatever this machine's `TMPDIR` is called)
  // is a temp root by the only convention a child can be told to aim at, so the ops carve-out
  // does not admit it as anyone's working directory — that is how a shared root under a name
  // the machine does not itself use still refuses the carve-out. A checkout, a worktree and an
  // operator's home each carry a name no temp root on any machine has.
  if (refused || isVolumeRoot || spellings.some((s) => tempNames.has(path.basename(s))))
    return undefined;
  return root;
}

/**
 * The roots this child may delete into, from the RAW env. Every role receives a
 * per-child temp root; a fenced dispatch also has its worktree and its scratch
 * dir. Never `loadFenceConfig` — it is undefined for exactly the reviewer and the
 * hatch cases this rule must still judge. A root the env names that is not a
 * usable directory is left out, so a child the driver gave nothing has NO allowed
 * root and every deletion it attempts is refused.
 */
export function deletionRootsFrom(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): DeletionRoots {
  const usable = [
    usableRoot(env.PI_ENSEMBLE_WRITE_ROOT),
    usableRoot(env.PI_ENSEMBLE_WRITE_SCRATCH),
    usableRoot(env[CHILD_TMP_ENV]),
    // The ops role's own working tree (see UNSCOPED_ROLE), and only while it is a working
    // tree: a cwd that is the temp root, $HOME or / is no one's working directory.
    isUnscopedRole(env.PI_ENSEMBLE_ROLE) ? usableWorkingDirectory(cwd, env) : undefined,
  ].filter((r): r is { label: string; real: string } => r !== undefined);
  return { cwd, labels: usable.map((r) => r.label), allowed: usable.map((r) => r.real) };
}

/** The refusal the child sees: the rule, the allowed roots, and never the target. */
export function deletionRefusalText(roots: DeletionRoots, why: string): string {
  const allowed = roots.labels.length > 0 ? roots.labels.join(", ") : "none";
  return `Refused: ${why}. Allowed roots: ${allowed}. Delete inside those, or report the need to the PM; a shared temp root, the main checkout, a sibling worktree and $HOME are not yours to remove.`;
}

/**
 * Register the deletion guard for this child. It registers for EVERY child in
 * every mode and role: no env switch is consulted, so neither a missing
 * `PI_ENSEMBLE_WRITE_ROOT` (a reviewer) nor the operator's
 * `PI_ENSEMBLE_WRITE_FENCE=0` (the developer hatch) can disarm it (#2200 D5).
 *
 * `roots` is injectable so the tests can point the rule at a fixture; production
 * reads the env and the cwd at registration, which is what the child's dispatch
 * decided for it.
 */
export function registerDeletionGuard(
  pi: ExtensionAPI,
  deps: { roots?: DeletionRoots; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): void {
  const env = deps.env ?? process.env;
  const roots = deps.roots ?? deletionRootsFrom(env, deps.cwd ?? process.cwd());
  const role = env.PI_ENSEMBLE_ROLE;
  const log = { scratch: env.PI_ENSEMBLE_WRITE_SCRATCH, repo: env.PI_ENSEMBLE_WRITE_REPO };
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown } | undefined | null)?.command;
    if (typeof command !== "string") return;
    let hit: DeletionHit | undefined;
    try {
      hit = firstDeletionOutside(command, roots);
    } catch (err) {
      // An internal fault is a refusal too: the call was not judged, so it does not run.
      const reason = `deletion guard could not judge this call: ${(err as Error).message}`;
      trace(`write-fence-deletion: ${reason}`);
      recordRefusal(log, NOT_JUDGED_LOG_TOKEN, reason, role);
      return { block: true, reason };
    }
    if (hit === undefined) return;
    const reason = deletionRefusalText(roots, hit.reason);
    recordRefusal(log, hit.token, reason, role);
    return { block: true, reason };
  });
}

/**
 * Record one refusal. A child with a scratch dir appends through the write fence's
 * own channel, so the driver counts it beside the fence's refusals. A child with
 * none — a reviewer, which the driver never fences — has no scratch to append to,
 * so the refusal reaches the ungated warn and is declared uncounted (#2200 D2):
 * the pinned refusal totals cover fenced children only.
 */
function recordRefusal(
  log: { scratch?: string; repo?: string },
  token: string,
  reason: string,
  role: string | undefined,
): void {
  if (log.scratch !== undefined && log.scratch !== "") {
    appendWriteFenceRefusal(
      log.scratch,
      { tool: "bash", path: token, reason, at: Date.now() },
      log.repo,
    );
    trace(`write-fence-deletion: refused a deletion (${token})`);
    return;
  }
  traceWarn(
    `write-fence-deletion: refused a deletion (${token}) for the ${role ?? "unroled"} child — not counted, it has no scratch dir`,
  );
}
