/**
 * worktree-provision-hook — the `.pi/worktree-setup` hook path for
 * `provisionWorktree`, with its #765 post-hook verification.
 *
 * Extracted from `worktree-provision.ts` (the 500-line file-size cap,
 * AGENTS.md §12 — the file sat AT the cap, leaving zero headroom for the
 * next edit; this is the same seam as `worktree-provision-verify.ts`).
 *
 * One responsibility: when the project provides `.pi/worktree-setup`, RUN
 * it in the worktree and then VERIFY on the filesystem what it actually
 * did. The hook contract — no arguments, no environment, cwd = the new
 * worktree, the hook locates `repoRoot` itself — is documented in
 * `worktree-provision.ts`'s module docstring, unchanged here.
 *
 * #765's post-hook verification is the load-bearing part of this seam:
 *
 *   - exit 0 records INVOCATION, the filesystem records provisioning.
 *     Each expected dependency source (resolved via
 *     `worktree-provision-verify.ts`) must RESOLVE to a non-empty directory
 *     — a no-op hook used to report an unqualified `via: "hook"`, so a
 *     verify gate ran against an unusable tree and parked with a false
 *     "does not build" diagnosis.
 *   - The precondition check (project expects deps but no source tree is
 *     non-empty — the #761 fork-A fresh-clone shape) is recorded as a
 *     `problem` at branch time instead of being discovered 61 minutes
 *     later at the commit-pr verify.
 *
 * Behaviour contract: a hook that exits non-zero returns
 * `{ via: "hook", problem, hookFailed: true }` (it never throws); a hook
 * that exits 0 returns `via: "hook"`, with a `problem` only when the project
 * expects an in-tree dependency directory the worktree does not have. A
 * project with nothing linkable (Rust, Go — see `IN_TREE_DEP_MARKERS`) is a
 * clean success, not a finding. Problems are returned, not traced here: every
 * caller that acts on one traces it, and tracing in both places printed the
 * same sentence twice.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace, traceWarn } from "./trace.ts";
import {
  anyLinkableSharedSource,
  expectedDepLocations,
  resolvedNonEmptyWithFault,
} from "./worktree-provision-verify.ts";
import { WORKTREE_SETUP_HOOK } from "./worktree-provision.ts";
import type { ExecFn, ProvisionResult } from "./worktree-provision.ts";

/**
 * How much of a hook's own output survives into `ProvisionResult.problem` when
 * the hook exits 0 and there is nothing else to say — the bare "the hook linked
 * nothing useful there" verdict.
 *
 * Bounded because `problem` is rendered into handoff text and PR bodies. The
 * budget is generous enough to hold the `worktree-setup: ERROR:` line plus
 * context, and `bound` keeps the HEAD so the hoisted cause is what survives.
 * It is NOT the budget the failed-hook catch clause uses — see the two below.
 */
const HOOK_PROBLEM_BUDGET = 380;

/**
 * Separate budgets for the two parts the catch clause joins (#1394).
 *
 * They used to share `HOOK_PROBLEM_BUDGET`, which meant the chatty part decided
 * how much of the quiet part survived: with a long `probeFailures` list — a
 * corrupt index plus a dozen package dirs, each carrying a message — the
 * `git could not classify: …` tail consumed the budget and the `source: <path>`
 * the operator needs to act on was cut. `named` is short by construction (the
 * list is capped), so giving it its own budget costs almost nothing in the
 * common case and loses nothing in the pathological one.
 */
const HOOK_CAUSE_BUDGET = 300;
const HOOK_NAMED_BUDGET = 80;

/** How many undetermined candidates one problem string names. */
const NAMED_PROBE_CAP = 6;

/**
 * The failed-hook `problem`, in two independently-budgeted parts — so the
 * chatty half cannot decide how much of the quiet half survives. The test
 * reaches this shape (chatty stderr AND a non-empty list) by corrupting the git
 * index, so the probe failures are real git errors rather than a hand-written
 * array.
 */
function hookFailureProblem(prefix: string, cause: string, probeFailures: string[]): string {
  const named =
    probeFailures.length > 0 ? ` [git check-ignore: ${namedList(probeFailures, "; ")}]` : "";
  return `${prefix}${bound(cause, HOOK_CAUSE_BUDGET)}${bound(named, HOOK_NAMED_BUDGET)}`;
}

/** The line `die()` in `.pi/worktree-setup` prints — the actionable one. */
const WORKTREE_ERROR_LINE = /worktree-setup:\s*ERROR:/i;

/**
 * `node_modules, extension/node_modules, …` — capped, so a repo with dozens of
 * package dirs cannot crowd the cause out of `problem`.
 */
function namedList(items: string[], sep: string): string {
  const shown = items.slice(0, NAMED_PROBE_CAP);
  const extra = items.length - shown.length;
  return shown.join(sep) + (extra > 0 ? ` (+${extra} more)` : "");
}

/**
 * The cause behind a failed command, bounded and ordered.
 *
 * `promisify(exec)` rejections carry the command's output in `stderr` and wrap
 * `Command failed: <cmd>` around `message`, so a head-slice of `message` on a
 * chatty command can contain nothing but the wrapper line — which is how a
 * 2 736-char rejection lost the `EACCES` that was the whole finding.
 *
 * Order matters as much as the cap. `provisionDepsHint` renders `event.problem`
 * at `slice(0, 200)`, so a cause that survives into `problem` past char 200 is
 * recorded and still invisible to the human who reads the hint. `worktree-setup:
 * ERROR:` is the diagnostic `die()` prints and it is the LAST line the hook
 * writes, so ERROR lines are lifted to the front, the remainder follows for
 * context, and only then is the whole thing capped. With no ERROR line to lift,
 * the raw output is returned as-is — its tail is where a failure lands, and
 * `bound`'s head-slice keeps the front, which is where the summary is.
 *
 * Deliberately a local copy of `worktree.ts`'s `gitErrorDetail` rather than an
 * import: `worktree.ts` imports `provisionWorktree` from
 * `worktree-provision.ts`, so importing back from here would cycle.
 */
function hookErrorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const message = typeof e?.message === "string" ? e.message.trim() : "";
  const raw = (stderr !== "" ? stderr : message !== "" ? message : String(err))
    .replace(/^\s*Command failed:[^\n]*\n?/, "")
    .trim();
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const flagged = lines.filter((l) => WORKTREE_ERROR_LINE.test(l));
  if (flagged.length === 0) return raw;
  return [...flagged, ...lines.filter((l) => !WORKTREE_ERROR_LINE.test(l))].join("\n");
}

/**
 * Bound `s` to `budget`, keeping what came FIRST.
 *
 * `hookErrorDetail` already puts the actionable line at the front, so the head
 * is the part worth keeping. The old implementation sliced the tail, which was
 * right when the cause happened to land last and wrong whenever it did not.
 */
function bound(s: string, budget: number): string {
  return s.length <= budget ? s : `${s.slice(0, budget)}…`;
}

/**
 * Run the project's setup hook in the worktree, then verify on the
 * filesystem what it actually did.
 *
 * **Never throws, and never rejects** — and #1394 is the reason that sentence
 * needs its own paragraph. AGENTS.md §7 promises provisioning never fails the
 * branch step, and a rejection here broke exactly that promise: the precondition
 * probe (`anyLinkableSharedSource` → `probeNonEmptyDirectory`) re-threw `EACCES`
 * and its call sat OUTSIDE the `try`, so one unreadable gitignored
 * `node_modules` made `provisionWorktree` reject, `worktreeCreate` propagated
 * it, the mechanized branch setup failed, and the branch step fell to the LLM
 * ops fallback (or halted `commit-pr`). So the precondition probe, the hook run,
 * the post-hook verification AND the catch clause all have to be fault-proof —
 * and the catch clause has to be fault-proof against faults from the
 * precondition too, which is why it is not merely the hook's `try`.
 *
 * Every probe below reports its fault as a `problem` (and a `traceWarn`),
 * exactly like `missingDepsFailure`'s catch does: a fault is information the
 * operator acts on, not an exception the driver dies on.
 */
export async function runHookProvisioning(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
  hook: string,
): Promise<ProvisionResult> {
  // #765 — precondition: the project expects deps (manifest present) but
  // no source tree is non-empty (fork-A: fresh clone). The hook's
  // deliberate exit-0-when-source-absent branch is untouched.
  //
  // #1394 — `anyLinkableSharedSource` is the probe-free predicate, and the
  // probe-free part is the point: at this moment the hook has not run, so
  // whether a candidate is gitignored says nothing about whether the hook has
  // anything to link. Asking it (the old call into `expectedDepLocations`
  // with no executor) made an unreadable directory answer "no source exists"
  // and printed a fresh-clone diagnosis for a repo whose tree is merely
  // locked. Probe faults are collected and counted as "something may be
  // there" — see the jsdoc on that function.
  const hookPreconditions: string[] = [];
  const sourceFaults: string[] = [];
  // Candidates whose gitignore status git could not answer. Declared before the
  // try so the catch can name them too: `hookFailed` reports the hook's exit
  // status, and a probe that could not run is what makes that status
  // actionable instead of mysterious.
  const probeFailures: string[] = [];
  // Did the hook process itself exit non-zero? Set after its exec call
  // resolves-with-a-throw, and the ONLY thing that justifies `hookFailed`.
  // Deliberately NOT inferred from `err.code` in the catch: an exit code rides
  // on a rejection from ANY exec call, so the `git check-ignore` probe's own
  // exit-128 would be read as "the hook failed" and the driver would report a
  // broken project hook on the evidence of a git error.
  let hookRan = false;
  let hookExit: number | undefined;
  try {
    const hookPackageDirs = await packageDirsAt(repoRoot);
    // #1394 — classify the candidates BEFORE running the hook, so the catch
    // clause below has them. Probing after the hook run meant a hook that died
    // — the one case where the operator most needs to know that git could not
    // classify the trees — reported a bare `hook failed (exit N)` with the
    // probe-failure list empty, because the throw skipped the probe entirely.
    // A pre-run verdict also stays valid: gitignore status is a property of
    // `repoRoot`, which the hook does not modify (it writes into the worktree
    // and `$GIT_COMMON_DIR/info/exclude`, not `.gitignore`).
    const expected = await expectedDepLocations(repoRoot, hookPackageDirs, execFn);
    probeFailures.push(...expected.undetermined);
    if (
      (await depsExpectedAt(repoRoot, hookPackageDirs)) &&
      !(await anyLinkableSharedSource(repoRoot, hookPackageDirs, sourceFaults))
    ) {
      hookPreconditions.push(
        "no non-empty dependency source (node_modules/.venv/vendor) at repoRoot or in the discovered " +
          "package dirs, yet the project expects dependencies here (a manifest/lockfile is present) — " +
          "the hook has nothing to link unless it installs from scratch; the worktree will be bare " +
          "until the source tree exists at repoRoot",
      );
    }
    if (sourceFaults.length > 0) {
      const sentence = `could not inspect the dependency source: ${namedList(sourceFaults, "; ")}`;
      traceWarn(`worktree: ${sentence}`);
      hookPreconditions.push(sentence);
    }
    // The hook's OWN rejection is recorded by the inner catch below — see
    // `hookRan`.
    try {
      await execFn(`sh ${JSON.stringify(hook)}`, {
        cwd: worktreeAbs,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      // The hook's OWN rejection: it ran and the process exited non-zero. Record
      // the exit code here — this is the only `code` the driver may attribute to
      // the hook — and let it reach the outer catch unchanged.
      hookRan = true;
      hookExit = (err as { code?: unknown })?.code as number | undefined;
      throw err;
    }
    // #765 — verify, do not assume: exit 0 records INVOCATION, the
    // filesystem records provisioning. Each expected location must RESOLVE
    // to a non-empty dir (catches stale symlinks). No stdout parsing.
    //
    // #1394 — the expectation is the SAME gitignore-filtered set the hook
    // itself filters against, computed above (see the comment there), and a
    // candidate git could not classify STAYS in it (named in `undetermined`)
    // rather than being dropped: dropping it made the expectation empty on a
    // repo with a broken git index, so a hook that linked nothing at all
    // reported a clean success and the develop gate's own fail-fast went
    // quiet with it.
    const verified: string[] = [];
    for (const { dirRel, source } of expected.locations) {
      const dep = path.basename(source);
      const target = path.join(worktreeAbs, dirRel, dep);
      const rel = dirRel === "" ? dep : path.join(dirRel, dep);
      const state = await resolvedNonEmptyWithFault(target);
      if (state.resolves) {
        verified.push(rel);
        continue;
      }
      // The probe-failure list is bounded separately from the sentence naming
      // it, in both directions: `bound` on the list (so a dozen package dirs
      // cannot crowd out the `source:` path) and no cap on the sentence itself
      // (the path and the fault are the actionable part).
      const namedProbes =
        probeFailures.length > 0
          ? ` (git could not classify: ${bound(namedList(probeFailures, ", "), HOOK_NAMED_BUDGET)})`
          : "";
      // Name the reason the verification itself could not look, when there was
      // one — "absent, stale, or empty" is the pre-#1394 guess, and an EACCES
      // on the worktree path is none of those three.
      const why =
        state.fault !== undefined
          ? `could not be inspected (${state.fault})`
          : "is absent, stale, or empty";
      const problem = bound(
        `${WORKTREE_SETUP_HOOK} exited 0 but ${rel} in the worktree ${why} ` +
          `(source: ${source}) — the hook linked nothing useful there${namedProbes}`,
        HOOK_PROBLEM_BUDGET,
      );
      return {
        via: "hook",
        linked: verified,
        problem:
          hookPreconditions.length > 0
            ? `${hookPreconditions.join("; ")} (and ${problem})`
            : problem,
      };
    }
    // #1394 — nothing was expected AND a probe could not answer: that is a
    // finding, not a clean pass. The loop above can only report a candidate it
    // was given, so an expectation shrunk to zero (or a source directory this
    // could not open) used to fall through to `via: "hook"` with no problem —
    // which is how "the verification could not run" became indistinguishable
    // from "the verification passed". `sourceFaults` is in the test as well as
    // `probeFailures`: a chmod-locked source tree is the very case #1394 is
    // about, and it produces neither an expected location nor a git verdict.
    if (expected.locations.length === 0 && (probeFailures.length > 0 || sourceFaults.length > 0)) {
      const couldNotAsk =
        probeFailures.length > 0
          ? ` (git could not classify: ${bound(namedList(probeFailures, ", "), HOOK_NAMED_BUDGET)})`
          : "";
      const couldNotLook =
        sourceFaults.length > 0
          ? ` (could not inspect: ${bound(namedList(sourceFaults, ", "), HOOK_NAMED_BUDGET)})`
          : "";
      const problem = bound(
        `${WORKTREE_SETUP_HOOK} exited 0 but no dependency tree could be verified${couldNotAsk}${couldNotLook} — the post-hook check could not run, so the worktree is UNVERIFIED`,
        HOOK_PROBLEM_BUDGET,
      );
      return {
        via: "hook",
        linked: verified,
        problem:
          hookPreconditions.length > 0
            ? `${hookPreconditions.join("; ")} (and ${problem})`
            : problem,
      };
    }
    // #765 — if NO source tree existed at hook-run time, the hook could
    // not have linked anything (fresh-clone fork-A shape). Only a finding
    // when the project expects one: with no in-tree dependency directory to
    // have, an empty `expected.locations` is the normal shape and the hook simply ran.
    if (hookPreconditions.length > 0) {
      return { via: "hook", linked: [], problem: hookPreconditions.join("; ") };
    }
    trace(`worktree: provisioned via ${WORKTREE_SETUP_HOOK}`);
    return { via: "hook", linked: verified };
  } catch (err) {
    // #1394 — the cause, not the wrapper, and not truncated from the front.
    // `promisify(exec)` reports a non-zero exit as a rejection whose `message`
    // begins `Command failed: sh .pi/worktree-setup` and whose real output sits
    // in `stderr`. The head-slice of `message` returned the wrapper plus
    // whatever the command printed first — on a build, a banner — and dropped
    // the `worktree-setup: ERROR: …` line that is the whole finding. Read
    // `stderr`, drop the wrapper, keep the actionable line inside the budget the
    // hint will apply.
    const cause = hookErrorDetail(err);
    // The hook process exited non-zero (its own failure) versus a fault raised
    // INSIDE this function — a precondition probe, the post-hook verification, or
    // the catch clause itself. Only the first is a "hook failed": labelling an
    // EACCES from a probe as a hook failure reports `hookFailed`, which the
    // driver renders as "the project's hook is broken" — an accusation the
    // evidence does not support.
    const prefix = hookRan
      ? `${WORKTREE_SETUP_HOOK} failed (exit ${hookExit}): `
      : `${WORKTREE_SETUP_HOOK} could not be provisioned: `;
    // Each part bounded on its own — see HOOK_CAUSE_BUDGET for why the join
    // is not one budget.
    const problem = hookFailureProblem(prefix, cause, probeFailures);
    if (!hookRan) {
      traceWarn(`worktree: ${problem}`);
      return { via: "hook", linked: [], problem };
    }
    return { via: "hook", linked: [], problem, hookFailed: true };
  }
}

/**
 * Depth-1 subdirectories of `repoRoot` that contain a dependency marker.
 *
 * Depth-1 only: deeper nesting is where per-worktree scratch (`.worktrees/`)
 * and vendor trees live, and scanning them would re-link the very worktrees
 * this module creates. Unreadable / non-directory `repoRoot` → no candidates.
 */
export async function packageDirsAt(repoRoot: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name);
  if (dirs.length === 0) return [];
  // Awaited one by one: `fileExists` returns a Promise, and a Promise is
  // always truthy — a bare `.some(fileExists)` made every directory a match.
  const hasMarker = async (dir: string) => {
    for (const m of DEPENDENCY_MARKERS) {
      if (await fileExists(path.join(repoRoot, dir, m))) return true;
    }
    return false;
  };
  const marked: string[] = [];
  for (const dir of dirs) {
    if (await hasMarker(dir)) marked.push(dir);
  }
  return marked;
}

/**
 * Does the project "plainly need" an in-tree dependency directory — one of
 * `IN_TREE_DEP_MARKERS` at the root, or in a discovered package directory?
 * Drives the `problem` field: a project that needs deps and has none findable
 * gets a trace, not a silent bare worktree.
 */
export async function depsExpectedAt(repoRoot: string, packageDirs: string[]): Promise<boolean> {
  const rootHit = await Promise.any(
    IN_TREE_DEP_MARKERS.map((m) =>
      fileExists(path.join(repoRoot, m)).then((ok) => (ok ? true : Promise.reject())),
    ),
  ).catch(() => false);
  if (rootHit) return true;
  for (const dir of packageDirs) {
    const dirHit = await Promise.any(
      IN_TREE_DEP_MARKERS.map((m) =>
        fileExists(path.join(repoRoot, dir, m)).then((ok) => (ok ? true : Promise.reject())),
      ),
    ).catch(() => false);
    if (dirHit) return true;
  }
  return false;
}

/**
 * Markers of an ecosystem whose dependencies are installed INSIDE the tree,
 * in a directory on `SHAREABLE_DEPS` (Node → `node_modules`, Python →
 * `.venv`). Only these can promise a tree a worktree lacks.
 *
 * Cargo, Go and Bundler are deliberately absent: by default they resolve
 * into a per-user cache outside the repository, and Rust's only in-tree
 * directory is `target/`, which is on `NEVER_SHARED`. A `Cargo.toml` with no
 * `node_modules` beside it is a complete project — reporting "expects
 * dependencies here" for one sent an operator after a fault that did not
 * exist while the worktree's gate ran green. A `vendor/` that does exist is
 * still linked; it is just not demanded.
 */
const IN_TREE_DEP_MARKERS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
];

/**
 * Manifest/lockfile markers: "this directory is a package", i.e. a place to
 * look for a nested `node_modules`. #481's discovery signal — depth-1
 * directories with any of these are scanned, so a nested-package monorepo
 * provisions without a hook and without knowing its own layout.
 */
const DEPENDENCY_MARKERS = [...IN_TREE_DEP_MARKERS, "go.mod", "go.sum", "Cargo.toml", "Gemfile"];

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
