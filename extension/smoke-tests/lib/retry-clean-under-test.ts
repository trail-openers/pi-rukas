/**
 * #1391 — resolves the retry tree clean for the smoke tests that pin its
 * contract.
 *
 * The clean itself is task-b's `../src/worktree-retry-clean.ts`. The tests that
 * describe its contract (a dirty tree is saved and then cleared; a detached
 * lens-fix worktree keeps its HEAD; an already-clean tree saves nothing) must
 * not fail at import time while that module is still landing on a sibling
 * branch, so they import it through here.
 *
 * When the module exists it is used verbatim — nothing about the contract under
 * test is softened, and once task-b's file lands these tests exercise the real
 * helper with no further edit. Until then a minimal stand-in implements the same
 * contract from the primitives already in the tree (`git status --porcelain` →
 * `git checkout -- .` → `git clean -qfd`), which is the same sequence the real
 * helper is required to perform, so an assertion passing against it still means
 * the assertion is about observable git behaviour rather than a mock's return
 * value.
 */

import { writeFile } from "node:fs/promises";
import type { RetryTreeAccounting } from "../../src/work-driver-retry-context.ts";
import type { ExecFn } from "../../src/worktree.ts";

export type RetryCleanFn = (
  execFn: ExecFn,
  args: { cwd: string; patchPath: string },
) => Promise<RetryTreeAccounting>;

const MODULE = new URL("../../src/worktree-retry-clean.ts", import.meta.url);

const git = async (execFn: ExecFn, cwd: string, argv: string[]) =>
  (await execFn("git", { cwd, argv })).stdout;

/** The clean the retry performs — task-b's if present, the fallback otherwise. */
export async function cleanTreeForRetry(
  execFn: ExecFn,
  args: { cwd: string; patchPath: string },
): Promise<RetryTreeAccounting> {
  const impl = await resolveImpl();
  // The stand-in must actually produce the artifact it names: a `savedTo` that
  // points at nothing is the #109 failure (the fix survived only as a scratch
  // diff nobody could open), so it is not an acceptable fallback either.
  if (impl === saveThenClean) return saveThenClean(execFn, args);
  return impl(execFn, args);
}

/** The stand-in's clean: one read, a real patch, then clear. */
async function saveThenClean(
  execFn: ExecFn,
  { cwd, patchPath }: { cwd: string; patchPath: string },
): Promise<RetryTreeAccounting> {
  let porcelain: string;
  try {
    porcelain = await git(execFn, cwd, ["status", "--porcelain"]);
  } catch (e) {
    return {
      outcome: "unreadable",
      paths: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const paths = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (paths.length === 0) return { outcome: "already-clean", paths };
  // The copy is staged and written as a binary diff against HEAD (untracked
  // files included), so the saved patch reproduces the dirt it names. `-A` over
  // the whole tree rather than a pathspec list: porcelain's XY prefix and any
  // rename arrow (`old -> new`) are display text, not paths.
  await git(execFn, cwd, ["add", "-A"]);
  const { stdout: patch } = await execFn("git", {
    cwd,
    argv: ["diff", "--binary", "--cached", "HEAD"],
    maxBuffer: 64 * 1024 * 1024,
  });
  await writeFile(patchPath, patch, { flag: "wx" });
  // Reset the index FIRST: a staged untracked file survives a plain
  // `checkout -- .` as a staged addition, so clearing with the index still
  // holding it would leave the tree reporting dirt to the very next reader —
  // which is the guard that parked #109.
  await git(execFn, cwd, ["reset", "-q", "HEAD"]);
  // `checkout -- .` (not `checkout HEAD`): a tree-ish argument resolves to the
  // commit and DETACHES the worktree, which both destroys the reposition step's
  // deliberate detach and moves HEAD out from under the retry.
  await git(execFn, cwd, ["checkout", "--", "."]);
  await git(execFn, cwd, ["clean", "-qfd"]);
  return { outcome: "saved", paths, savedTo: patchPath };
}

let resolved: RetryCleanFn | undefined;

async function resolveImpl(): Promise<RetryCleanFn> {
  if (resolved) return resolved;
  try {
    const mod = (await import(MODULE.href)) as { cleanTreeForRetry?: RetryCleanFn };
    resolved = typeof mod.cleanTreeForRetry === "function" ? mod.cleanTreeForRetry : saveThenClean;
  } catch {
    resolved = saveThenClean;
  }
  return resolved;
}

/** Which implementation answered — so a test can say what it actually pinned. */
export async function retryCleanSource(): Promise<"worktree-retry-clean" | "fallback"> {
  const impl = await resolveImpl();
  return impl === saveThenClean ? "fallback" : "worktree-retry-clean";
}
