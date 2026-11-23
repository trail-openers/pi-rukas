/**
 * lean/specify-format — bring each submitted test file to the project's format before it is proven
 * red and frozen.
 *
 * `build` may not edit a frozen file, so a frozen test that fails a project tier's format check
 * (`rustfmt --check`, `prettier --check`, …) can never go green. `verify.format` names the
 * project's formatter as a `{file}` template, run in argv form exactly like `verify.test`; the
 * bytes the red proof runs on, and the commit hashes, are then the formatted ones. Unset: nothing
 * runs.
 */
import type { ExecFn } from "../worktree.ts";
import { runTestFile } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { changedPaths } from "./specify-tree.ts";
import type { VerifyExec } from "./verify-types.ts";

/**
 * Format `files` in `wt`. Returns the files the formatter refused, each with its reason, for the
 * caller to drop. Throws when the formatter wrote any path it was not handed: a config that
 * reformats the project is not a refusal of the child's file, and its writes would ride into the
 * frozen commit's tree.
 */
export async function formatSubmitted(
  exec: ExecFn,
  wt: string,
  template: string,
  files: string[],
): Promise<{ path: string; reason: string }[]> {
  const before = new Set((await changedPaths(exec, wt)).map((e) => e.path));
  const refused: { path: string; reason: string }[] = [];
  for (const file of files) {
    const ran = await runTestFile(exec as VerifyExec, { wt, template, file });
    // A formatter that never started, hung or overflowed says nothing about the child's file.
    if (ran.kind === "infra")
      throw new SpecifyInfraError(`verify.format \`${ran.cmd}\`: ${ran.detail}`);
    if (ran.kind !== "green")
      refused.push({ path: file, reason: `verify.format \`${ran.cmd}\` failed: ${ran.detail}` });
  }
  const handed = new Set(files);
  const stray = (await changedPaths(exec, wt))
    .map((e) => e.path)
    .filter((p) => !handed.has(p) && !before.has(p));
  if (stray.length > 0)
    throw new SpecifyInfraError(
      `verify.format wrote outside the submitted test files: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ` (+${stray.length - 5} more)` : ""}`,
    );
  return refused;
}
