/**
 * Points the spawn path's role prompts at a test-owned directory (issue #1579).
 *
 * `src/roles.ts` resolves every role prompt ONCE, at module load, from
 * `PI_ENSEMBLE_PROMPTS_DIR` or else from `<checkout>/dist/prompts/standard`.
 * `dist/` is gitignored and produced only by `bun run build`, so a fresh
 * worktree has none, and a host that exports the variable points the probe at
 * another checkout's build. Either way the abort probe's spawn read a path the
 * test does not own (ENOENT, or a sibling tree being rebuilt under it).
 *
 * Import this module FIRST in test-cancel.ts: ES modules evaluate in import
 * order, so this side effect runs before `roles.ts` is evaluated. The fake
 * `pi` never reads the prompt, so a one-line stub per role is enough to make
 * the spawn's read succeed without depending on the build.
 *
 * Intentionally NOT named `test-*.ts` (same shape as the other lib helpers).
 * It must not import `roles.ts` itself, or that import would run before the
 * override below and the override would be too late.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirrors ROLE_NAMES in src/roles.ts. Hard-coded on purpose: importing that
// module here would evaluate it before the env override below.
const ROLE_FILES = [
  "project-manager",
  "developer",
  "ops",
  "explore",
  "adversarial-developer",
  "code-review-specialist",
] as const;

/** The directory this process's role prompts are read from. Owned by this run. */
export const CANCEL_PROMPTS_DIR: string = mkdtempSync(
  join(tmpdir(), "pi-ensemble-cancel-prompts-"),
);

mkdirSync(CANCEL_PROMPTS_DIR, { recursive: true });
for (const role of ROLE_FILES) {
  writeFileSync(
    join(CANCEL_PROMPTS_DIR, `${role}.md`),
    `# ${role}\n\nstub prompt for test-cancel\n`,
  );
}

// Overrides whatever the host exported. Read by roles.ts at its load time,
// which is after this module's body has run (see the header).
process.env.PI_ENSEMBLE_PROMPTS_DIR = CANCEL_PROMPTS_DIR;

// process.exit runs 'exit' listeners, so this also covers the ceiling's exit
// path in test-cancel.ts, which skips its own finally block.
process.on("exit", () => {
  rmSync(CANCEL_PROMPTS_DIR, { recursive: true, force: true });
});
