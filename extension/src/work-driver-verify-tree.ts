/**
 * work-driver-verify-tree — #1240: the tree identity behind "this tree was
 * already verified".
 *
 * The develop gate runs the project's verify command TWICE on the same
 * content in an N=1 cycle: once in the develop worktree
 * (`work-driver-verify-verify-cmd.ts`) and once at repoRoot for the
 * consolidated probe (`work-driver-consolidated-verify.ts`), which cherry-
 * picks that one workstream's own commits onto `baseSha` — the same commit
 * range the worktree holds, so the resulting tree is byte-identical. The
 * consolidated half is pure duplicate work: measured on the orchard factory,
 * ~21 minutes per pass, a third of a three-round cycle.
 *
 * Identity is established POSITIVELY, from git's own tree object ids:
 *
 *   - the tree that PASSED in the worktree — the HEAD commit's tree when
 *     every developer change is committed, the INDEX tree of the same
 *     worktree when it holds uncommitted changes that the consolidation
 *     transplants as a patch;
 *   - the tree the consolidated verify is about to run — the INDEX tree at
 *     repoRoot after the cherry-picks landed (uncommitted by construction:
 *     `cherryPickWorkstreams` picks with `--no-commit`).
 *
 * Both sides therefore include staged content and exclude untracked files:
 * the driver's own index-free scaffolding (`.worktrees/`, `.pi/`, `tmp/`)
 * never enters the hash, while a dirty worktree's staged work does. A
 * mismatch, an unreadable hash on either side, or a cycle shape that is not
 * the single-workstream one means NO skip — every failure routes to "run
 * the consolidated verify exactly as before". A gate that cannot prove
 * equivalence runs the check.
 */
import type { ExecFn } from "./worktree.ts";

/** git's own object id shape — anything else is not a hash we can trust. */
const TREE_HASH_RE = /^[0-9a-f]{40}$/;

/**
 * The tree that already passed a verify run, plus the worktree it was judged
 * in. This is an *identity*, never a skip decision: the two skip seams
 * (`consolidatedVerifySkip`, `commitPrSkipDecision`) compare it against the
 * tree they are about to verify and run the command on any mismatch.
 *
 * Declared here, beside the producer of every one of its `treeHash` values,
 * so the shape carried from `verifyTreeId` through the eligibility seams to
 * the `consolidated-verify-skipped` event cannot drift per file.
 */
export type AlreadyVerifiedTree = { treeHash: string; worktree: string };

/**
 * The tree the project's verify command actually sees in one working tree, or
 * `undefined` when git could not establish it (a read failed, the output is
 * not an object id, or the working tree holds content no tree object
 * describes) — an executor that answers nothing is never read as a hash.
 *
 * Two reads, deliberately:
 *
 *   1. `git write-tree` — the INDEX, promoted to a tree object. Content
 *      staged but not committed counts.
 *   2. `git rev-parse HEAD^{tree}` — the HEAD commit's tree.
 *
 * HEAD is the identity whenever the index and HEAD agree, and `write-tree`
 * when they do not — the index is what a pending consolidation transplants,
 * so a worktree holding staged-but-uncommitted work is identified by its
 * index, matching the probe's own index at repoRoot (picks are `--no-commit`).
 *
 * Neither hash is returned when the working tree holds content NO tree object
 * describes (unstaged modifications, deletions, untracked-not-ignored files):
 * the verify command reads FILES, so a hash of HEAD there would be a claim
 * about content that is not what was tested. Driver-managed scaffolding
 * (`.worktrees/`, `.pi/`, `tmp/`) does not count, so the driver's own scratch
 * never defeats the identity — but only while it is UNTRACKED (see
 * `isDirtForTreeIdentity`).
 */
export async function verifyTreeId(execFn: ExecFn, cwd: string): Promise<string | undefined> {
  const run = async (cmd: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 });
      const out = stdout.trim();
      return TREE_HASH_RE.test(out) ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const status = await porcelain(execFn, cwd);
  if (status === undefined) return undefined;
  if (hasWorkingTreeDirt(status)) return undefined;
  const staged = await run("git write-tree");
  const committed = await run("git rev-parse HEAD^{tree}");
  if (staged === undefined || committed === undefined) return undefined;
  return staged === committed ? committed : staged;
}

/**
 * `git status --porcelain -uall`, or `undefined` when the read failed. The
 * status is read FIRST because it decides whether either hash is meaningful.
 */
async function porcelain(execFn: ExecFn, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git status --porcelain -uall", {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Does this porcelain output describe content that NO tree object holds —
 * unstaged modifications or deletions (worktree column set), or
 * untracked-but-not-ignored files?
 *
 * Staged-only entries (index column set, worktree column blank: `A `, `M `)
 * are NOT dirt: `git write-tree` describes them exactly, and they are the
 * shape a develop worktree with uncommitted work presents to the
 * consolidation, which transplants them as a patch.
 *
 * Untracked files ARE dirt here even though `write-tree` ignores them: an
 * untracked file can change what the verify command does (the smoke loop
 * greps sources, a TypeScript build reads every file under `src/`), so a tree
 * holding one is not a tree whose identity was verified. The exemption is
 * therefore NOT the shared `isDriverManagedDirtLine` prefix set — that admits
 * any untracked path under `tmp/`, `.pi/` or `.worktrees/`, which would make
 * a `?? tmp/evil.ts` that changes what the command reads invisible. Only the
 * artefacts the driver itself writes are exempt (see
 * `isDriverArtefactPath`); every other untracked path is dirt.
 *
 * The worktree-column test is on porcelain's SECOND column, not its third:
 * `XY PATH` puts the separator at index 2, so a check there is dead code that
 * silently passes every dirty tree — which is the shape #1240's whole safety
 * argument rests on. See `isDirtForTreeIdentity`.
 */
function hasWorkingTreeDirt(status: string): boolean {
  return status.split("\n").some(isDirtForTreeIdentity);
}

/**
 * One porcelain line, judged for tree identity — locally, NOT via
 * `isDriverManagedDirtLine` (work-driver-branch-residue.ts), which the
 * dirty-root gates also use.
 *
 * That shared predicate exempts a path under `.worktrees/`, `.pi/` or `tmp/`
 * for ANY XY code, because those gates ask a different question: "did a
 * previous cycle leave SCRATCH here that the operator should clear?" For tree
 * identity the question is "do the FILES match a tree object?", and a
 * TRACKED modification answers it the same way anywhere in the tree: `.pi/`
 * and `tmp/` are not gitignored, so a tracked ` M .pi/verify-cmd` is the
 * operator's own gate being edited while the verify supposedly ran against
 * it. Hashing HEAD or the index there would certify a tree that is not the
 * content the command read.
 *
 * So the exemption applies ONLY to untracked entries (`??`) AND only to the
 * paths the driver itself writes — `.worktrees/` (its detached worktrees),
 * `.pi/work-state/` (its state files and per-issue artifacts) and
 * `tmp/issue-<N>/` (its scratch). A tracked modification or deletion under one
 * of those prefixes is dirt, and an untracked file anywhere ELSE is dirt too:
 * dirt means no identity, which means the verify runs.
 */
export function isDirtForTreeIdentity(line: string): boolean {
  if (line.trim().length === 0) return false;
  // An untracked entry: `?? path`.
  if (line.startsWith("??")) return !isDriverArtefactLine(line);
  // Porcelain v1 is `XY<space>PATH`: index 0 is the INDEX column, index 1 the
  // WORKTREE column, index 2 the separator — always a space, which is why
  // testing index 2 here could never fire (measured: a worktree holding an
  // unstaged ` M tracked.txt` and an index-deleted ` D file` both returned a
  // HEAD hash, i.e. the identity claimed a tree no tree object describes).
  // The Y column (index 1) set means the FILES differ from every tree object;
  // a blank there means the index describes them. A tracked entry is dirt
  // whenever Y is set, whatever the path: `isDriverManagedDirtLine` is
  // deliberately not consulted.
  return line.length > 1 && line[1] !== " ";
}

/**
 * The untracked paths the DRIVER wrote, exempted from tree identity.
 *
 * `isDriverManagedDirtLine` (the dirty-root gates' predicate) exempts a path
 * under `.worktrees/`, `.pi/` or `tmp/` wholesale. That is the right question
 * for "what scratch did a previous cycle leave here that the operator should
 * clear?" and the wrong one for "do the FILES match a tree object?": a `??
 * tmp/evil.ts` the developer dropped next to the driver's scratch changes what
 * the verify command reads, and the shared predicate would wave it through.
 *
 * So this names the driver's OWN artefacts and nothing else:
 *
 *   - `.worktrees/…`            — every detached worktree the driver creates;
 *   - `.pi/work-state/…`        — its state files and per-issue artifact dirs;
 *   - `tmp/issue-<N>/…`         — the cycle scratch the driver creates.
 *
 * Anything else untracked — `?? tmp/evil.ts`, `?? .pi/other` — counts as
 * dirt, which means no identity, which means the verify runs. Quoted paths
 * (`?? "tmp/evil.ts"`) are normalised before matching, because porcelain v1
 * quotes a path carrying a space or a special character.
 *
 * ONE deliberate addition to the driver's-own list: `.pi/verify-cmd` and
 * `.pi/verify-cmd-fast` — the project's gate definitions, which the driver
 * reads but never writes and which every project leaves UNTRACKED. Treating an
 * untracked one as dirt would deny identity to every real cycle and make the
 * skip unobservable. The TRACKED form is still dirt (case l1: a
 * ` M .pi/verify-cmd` is the operator editing the gate mid-cycle), and both
 * sides of the comparison read the same file from repoRoot.
 */
const DRIVER_GATE_FILES = new Set([".pi/verify-cmd", ".pi/verify-cmd-fast"]);

export function isDriverArtefactPath(rawPath: string): boolean {
  const p = rawPath.trim().replace(/^"+|"+$/g, "");
  if (DRIVER_GATE_FILES.has(p)) return true;
  return (
    p === ".worktrees" ||
    p.startsWith(".worktrees/") ||
    p === ".pi/work-state" ||
    p.startsWith(".pi/work-state/") ||
    /^tmp\/issue-\d+\/(?!\.\.\/)/.test(p)
  );
}

/** The same rule applied to one `?? path` porcelain line. */
function isDriverArtefactLine(line: string): boolean {
  return isDriverArtefactPath(line.slice(2));
}

/**
 * Escape hatch: `PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP` set to `0`, `false`,
 * `off` or `no` (trimmed, case-insensitive — the same vocabulary the repo's
 * other gates accept) restores the pre-#1240 behaviour, the consolidated
 * verify always runs. Anything else, including a malformed value, keeps the
 * skip available — the safe side is the one that runs the check.
 */
const SKIP_DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

export function consolidatedVerifySkipEnabled(): boolean {
  const raw = process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
  if (raw === undefined) return true;
  return !SKIP_DISABLED_VALUES.has(raw.trim().toLowerCase());
}
