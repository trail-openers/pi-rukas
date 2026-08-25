/**
 * work-driver-commit-inspect — #500: post-facto repoRoot inspection for the
 * commit-pr step.
 *
 * `mechanizedCommitPr` leaves repoRoot in a state it controls: `integrate()`
 * either succeeds (branch checked out, commit clean, pushed) or rolls back
 * via `restoreRoot()`. The LLM ops fallback, however, consolidates repoRoot
 * BY HAND — and issue #481's live cycle left it on the feature branch with
 * two `UU` paths and eight staged files, which `integrate()`'s dirty-repoRoot
 * preflight then refuses to touch, wedging every later cycle at commit-pr
 * with no explanation of why the tree is dirty.
 *
 * This module is the post-hoc inspection the fallback path never had: one
 * `git status --porcelain -z` + `git rev-parse --abbrev-ref HEAD` after the
 * fallback dispatch completes, parsed into facts the handoff renderers
 * (`commitPrRoot` / `commitPrRootError` in pipelineState) render as the
 * branch, the unmerged paths, the staged count, and the exact command that
 * clears the state. It records what the cycle LEFT; it does not modify
 * repoRoot, and it deliberately does not reimplement `integrate()`'s
 * rollback — that already works (test-integrate-aborts.ts).
 *
 * Also owns `commitPrRootFactLines`, the single source of the recorded-state
 * fact lines (branch, unmerged paths, staged count, clearing command) shared
 * by BOTH handoff surfaces — the "agree by copy" shape that produced the
 * "adversarial-loop" default in 23 of 53 handoffs.
 *
 * Kept in its own file (not inlined into work-driver-commit.ts) because both
 * of the natural homes sat near the 500-line gate at the time of writing
 * (work-driver-commit.ts ~396, workflow-state-schema.ts ~466).
 */

import { trace } from "./trace.ts";
import type { CommitPrRootState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * `CommitPrRootState` is defined in workflow-state-schema.ts — it is part of
 * the persisted state contract (`PipelineState.commitPrRoot`) — and
 * re-exported here for the driver-side write sites that import from this
 * module.
 */
export type { CommitPrRootState } from "./workflow-state-schema.ts";

export type CommitPrRootInspect =
  | { ok: true; state: CommitPrRootState }
  | { ok: false; error: string };

/**
 * Parse `git status --porcelain -z` output into a `CommitPrRootState` (defined
 * in workflow-state-schema.ts). Exported for direct unit testing; the
 * `branch` parameter comes from a separate call.
 *
 * Porcelain format: `XY <path>\0` where X (col 1) is the staged state and Y
 * (col 2) the worktree state. Unmerged paths have X/Y ∈ {U, A, D, .} — in
 * practice `UU`, `AA`, `DD`, `AU`, `UA` etc. Untracked is `??`.
 * Rename/copy entries (`R ` / `C `) record a SECOND NUL-separated token —
 * the destination path — which is the one an operator can `git add` /
 * `git status` on; the parser consumes it so the old name is never counted
 * as an entry of its own.
 *
 * The `-z` (NUL-separated) form is load-bearing, for the same reason
 * work-driver-stage.ts uses it: the plain form C-quotes special-character
 * paths (`"src/we\\ttab.rs"`), and a recorded path is only useful if the
 * rendered clearing commands (`git add <path>` / `git checkout --theirs`) can
 * operate on it as-is. NUL-separated output never quotes.
 *
 * `stagedCount` counts entries with a non-space column 1 — the staged set
 * (`M `, `A `, `MM`, `M `, unmerged…). Untracked (`??`) is dirt the operator
 * sees in `totalEntries`, but it is not staged and the rendered
 * `git reset --hard` clearing command would not remove it.
 */
export function parseCommitPrStatus(porcelain: string, branch: string): CommitPrRootState {
  const raw = porcelain
    .split("\0")
    .map((l) => l.trimEnd())
    .filter((l) => l.length >= 4); // "XY path" — anything shorter is noise
  // Flatten rename/copy pairs: the destination (second token) replaces the
  // source, keeping only the source's status columns. `raw` is pre-filtered
  // to >= 4 chars, so a rename destination token (which is always present in
  // well-formed output) is the only gap; fall back to the source's own path
  // when it is missing so the entry is still recorded rather than dropped.
  const entries: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? "";
    if (line.length < 4) continue;
    const x = line[0];
    // Rename/copy markers appear in column 1 only — git porcelain emits
    // `R ` / `C ` pairs and no `R?` / `C?` shape (a staged copy already
    // removed its source). When one is seen, the destination token is part
    // of git's output well-formedness and follows immediately; the
    // `?? line.slice(2)` only guards a truncated stream.
    if (x === "R" || x === "C") {
      entries.push(`${x}${line[1]} ${raw[i + 1]?.slice(2) ?? line.slice(2)}`);
      i += 1; // consume the destination token
      continue;
    }
    entries.push(line);
  }
  const unmergedPaths: string[] = [];
  let stagedCount = 0;
  for (const line of entries) {
    const x = line[0];
    const y = line[1];
    // Unmerged: at least one side records U, or the classic `UU`/`AA`/`DD`
    // shapes where both sides disagree. `UD` (unmerged deletion) etc. all
    // carry a U on one side.
    if (x === "U" || y === "U") unmergedPaths.push(line.slice(3));
    // `M ` (worktree-dirty), `??`, and `!!` have no staged component.
    if (x !== " " && x !== "?" && y !== "?") stagedCount += 1;
  }
  return {
    branch,
    unmergedPaths,
    stagedCount,
    totalEntries: entries.length,
    capturedAt: Date.now(),
  };
}

/**
 * The commit-pr handoff's shared fact lines: branch, unmerged-path list,
 * staged count, and the per-state clearing command. Single source for BOTH
 * handoff surfaces (work-driver-handoff-markdown.ts and
 * work-driver-handoff-message.ts) — pre-#500 the two surfaces agreed by copy,
 * and copy is how the "adversarial-loop" default told the wrong gate failed
 * in 23 of 53 handoffs.
 *
 * `prefix` is the command prefix (the chat surface uses
 * `git -C <repoRoot> `; the GitHub body uses none — the operator runs from
 * repoRoot). `indent` matches each surface's list style. A placeholder
 * branch (`HEAD` / `(detached or unknown)`) never reaches a `reset --hard`
 * command: `git reset --hard HEAD` aborts a merge in progress WITHOUT
 * clearing the index, which leaves exactly the unmerged state that blocks
 * `git apply`.
 */
export function commitPrRootFactLines(
  root: CommitPrRootState | undefined,
  err: string | undefined,
  prefix: string,
  indent: string,
): string[] {
  if (!root && !err) return [];
  const lines: string[] = [];
  if (!root && err) {
    // The inspection ran and failed: no state is recorded at all, so the
    // handoff must not let the "clean tree" framing of the recovery commands
    // survive by omission — say explicitly that cleanness is unknown and the
    // commands need a `git status` first. Both surfaces stay consistent this
    // way instead of only the explainCap blurb carrying the caveat.
    lines.push(
      `${indent}repoRoot state unknown — the post-PR inspection failed (${err}); do NOT assume the tree is clean, run \`${prefix}git status\` before the recovery commands.`,
    );
    return lines;
  }
  if (root) {
    lines.push(`${indent}branch: \`${root.branch}\``);
    lines.push(
      root.unmergedPaths.length > 0
        ? `${indent}unmerged paths (${root.unmergedPaths.length}):`
        : `${indent}unmerged paths: none`,
    );
    if (root.unmergedPaths.length > 0) {
      lines.push(...root.unmergedPaths.map((p) => `${indent}  - \`${p}\``));
    }
    lines.push(
      `${indent}staged-but-uncommitted: ${root.stagedCount} of ${root.totalEntries} porcelain entries`,
    );
    const placeholderBranch = root.branch === "HEAD" || root.branch === "(detached or unknown)";
    if (root.unmergedPaths.length > 0) {
      lines.push(
        "",
        `${indent}The consolidation below will FAIL until these are resolved — \`git apply\` refuses a tree with unmerged paths. Resolve the conflicts by hand (or abort them), then re-apply:`,
        "",
        `${prefix}git checkout --theirs -- <path>   # per conflicting path, once decided`,
        `${prefix}git add <path>`,
        "",
        placeholderBranch
          ? `${indent}To discard the hand consolidation entirely (DESTRUCTIVE — the uncommitted work is lost), name the branch first:`
          : `${indent}To discard the hand consolidation entirely (DESTRUCTIVE — the uncommitted work is lost):`,
        "",
        ...(placeholderBranch ? [`${prefix}git rev-parse --abbrev-ref HEAD`] : []),
        placeholderBranch
          ? `${prefix}git reset --hard <branch>`
          : `${prefix}git reset --hard ${root.branch}`,
      );
    } else if (root.stagedCount > 0) {
      if (placeholderBranch) {
        lines.push(
          "",
          `${indent}The index holds ${root.stagedCount} staged file(s). To discard them first (DESTRUCTIVE — the uncommitted work is lost), name the branch first:`,
          "",
          `${prefix}git rev-parse --abbrev-ref HEAD`,
          `${prefix}git reset --hard <branch>`,
        );
      } else {
        lines.push(
          "",
          `${indent}The index holds ${root.stagedCount} staged file(s) on \`${root.branch}\`. The commands below apply on top of it; if that is not what you want, discard it first (DESTRUCTIVE — the uncommitted work is lost):`,
          "",
          `${prefix}git reset --hard ${root.branch}`,
        );
      }
    } else if (root.totalEntries > 0) {
      // #539 — untracked leftovers (`??`) count in `totalEntries` but in
      // neither `stagedCount` nor `unmergedPaths`, so pre-#539 this was the
      // clean-tree branch: "The tree is clean — the recovery commands below
      // apply as-is" rendered on exactly the tree shape that wedged #533/#534
      // at integrate()'s dirty preflight. Say what is actually there and
      // route the operator to `git status` first.
      lines.push(
        "",
        `${indent}${root.totalEntries - root.stagedCount} untracked/unstaged file(s) — the tree is NOT clean. Run \`${prefix}git status\` first: the dirty paths may belong to another cycle (check \`.pi/work-state/\` before discarding), and the recovery commands below commit ONLY the applied patch paths.`,
      );
    } else {
      lines.push("", `${indent}The tree is clean — the recovery commands below apply as-is.`);
    }
  }
  return lines;
}

/**
 * The one-sentence recorded-state summary the explainCap blurb appends to
 * the commit-pr-family caps. Sibling of `commitPrRootFactLines`: that one
 * renders the multi-line fact list, this one the inline tail. `noConflictTail`
 * is the case-specific tail for the clean-state branch (the two caps whose
 * recovery commands reference `git apply` differ from the integration-verify
 * cap's "clear it" phrasing).
 */
export function commitPrRootBlurb(
  // #539 — documented intentional loosening of `CommitPrRootState`: `totalEntries`
  // is optional here because pre-#539 state files record the same shape
  // without it, and a missing field reads as "cleanness unknown" (the
  // honest answer) rather than a second "clean" claim. The canonical type
  // stays one interface (workflow-state-schema.ts); the `?` is the only
  // divergence, and it is written out so a future addition to
  // `CommitPrRootState` reaches this parameter too.
  root:
    | (Omit<CommitPrRootState, "capturedAt" | "totalEntries"> & {
        totalEntries?: number;
      })
    | undefined,
  err: string | undefined,
  noConflictTail: string,
): string {
  if (root) {
    // #539 — the untracked-dirt blind spot: with `totalEntries > 0` and
    // nothing staged/unmerged, the root is NOT clean even though the staged
    // count says 0. A missing `totalEntries` (pre-#539 state) says "unknown",
    // never "clean".
    const untracked =
      root.totalEntries !== undefined
        ? root.totalEntries - root.stagedCount - root.unmergedPaths.length
        : 0;
    const dirtyTail =
      untracked > 0
        ? `${untracked} untracked/unstaged file(s) remain (the tree is NOT clean) — run \`git status\` before re-applying patches`
        : root.totalEntries === undefined
          ? "cleanness of unstaged/untracked files unknown — run `git status` before re-applying patches"
          : noConflictTail;
    return ` repoRoot is on \`${root.branch}\` with ${root.stagedCount} staged file(s)${root.unmergedPaths.length > 0 ? ` and ${root.unmergedPaths.length} UNMERGED path(s) (${root.unmergedPaths.join(", ")})` : ""}${untracked > 0 ? ` and ${untracked} untracked entr${untracked === 1 ? "y" : "ies"} (the tree is NOT clean — run \`git status\` first)` : ""} — ${root.unmergedPaths.length > 0 ? "resolve those conflicts (the handoff body names each path and the clearing command) before any `git apply` will run" : dirtyTail}.`;
  }
  return err
    ? ` The repoRoot state inspection failed (${err}) — run \`git status\` before the recovery commands.`
    : "";
}

/**
 * Run the inspection against repoRoot. `execFn` is the driver's injected
 * executor (test seam) or the real `execp` — the same seam the rest of
 * commit-pr uses, so a smoke test's scripted git answers flow through here.
 *
 * Failures are RETURNED, not thrown: a failed `git status` at handoff time
 * is itself a fact worth surfacing (`commitPrRootError`), and throwing here
 * would turn an inspection into a step failure the router would retry.
 */
export async function inspectCommitPrRoot(
  execFn: ExecFn,
  repoRoot: string,
): Promise<CommitPrRootInspect> {
  try {
    const [{ stdout: statusOut }, { stdout: branchOut }] = await Promise.all([
      execFn("git status --porcelain -z", { cwd: repoRoot, maxBuffer: 256 * 1024 }),
      execFn("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 }),
    ]);
    const branch = branchOut.trim() || "(detached or unknown)";
    return { ok: true, state: parseCommitPrStatus(statusOut, branch) };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = (e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300);
    trace(`work-driver: commit-pr repoRoot inspection failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
